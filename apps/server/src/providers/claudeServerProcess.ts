// Claude Code on a server Project's server, with no Octant there: the Agent
// SDK composes the launch here as it does for a local one, and the process it
// would spawn runs instead in the Project's folder on the server, started
// through the host's SSH connection. The SDK's stream-json control protocol
// rides that connection's standard streams unchanged, and everything Octant
// adds travels inside it: its in-process MCP server (`setMcpServers` with
// `type: "sdk"`), `canUseTool`, and the SDK's callback hooks. Nothing on the
// server reaches this host.
//
// Nothing of this host's launch applies there: no Octant sandbox (none can run
// on the server, so Strict refuses this launch), no egress proxy, no account
// directory, environment or credentials of this host. Claude Code signs in as
// the server login and keeps its own permission modes and settings there.

import { EventEmitter } from "node:events";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderServerPlacement } from "@octant/provider-sdk/driver";
import { claudeProjectFolderName, parseAuthenticationStatus } from "./claudeProcess";
import type { ServerSignIn } from "./serverSignIn";

/** The program a placed launch runs: whatever `claude` an SSH login there finds. */
export const CLAUDE_SERVER_PROGRAM = "claude";

/** Said when Strict is on for a thread whose Claude Code would run on its server. */
export const CLAUDE_SERVER_STRICT_REFUSAL =
  "Strict needs Octant's own sandbox, which can't run on a server. Turn Strict off for this thread to run Claude Code there.";

const VERSION_TIMEOUT_MS = 20_000;
const SIGN_IN_TIMEOUT_MS = 20_000;
const SESSION_LOOKUP_TIMEOUT_MS = 20_000;
const VERSION_PATTERN = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?: \(Claude Code\))?\s*$/;
/** Claude Code names its sessions by UUID; anything else is not looked up. */
const SESSION_ID_PATTERN = /^[0-9A-Za-z-]{1,128}$/;

/**
 * The variables a placed launch passes on, all fixed switches the SDK and the
 * driver set: the SDK's own entry point and version, and the driver's
 * session-state events and MCP tool timeout. The rest of the environment the
 * SDK hands the spawn is this host's and stays here. A value goes on the
 * server's command line, which its process list shows, so only these
 * non-secret switches may.
 */
const FORWARDED_SWITCHES = [
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
  "MCP_TOOL_TIMEOUT",
] as const;
const SWITCH_VALUE = /^[0-9A-Za-z._-]{1,64}$/;
/** The credentials a local launch can carry, none of which may reach an argument. */
const CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** The version `claude --version` printed on the server, or why it could not be read. */
export async function readClaudeVersionOnServer(
  placement: ProviderServerPlacement,
): Promise<
  | { readonly status: "found"; readonly version: string }
  | { readonly status: "refused"; readonly message: string }
> {
  const ran = await placement.run([CLAUDE_SERVER_PROGRAM, "--version"], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (ran.status === "unreachable") return { status: "refused", message: ran.message };
  // 127 is the shell's "command not found".
  if (ran.exitCode === 127) {
    return {
      status: "refused",
      message: `Claude Code isn't installed on ${placement.serverName}, or isn't on the PATH an SSH login gets there.`,
    };
  }
  const version = ran.exitCode === 0 ? VERSION_PATTERN.exec(ran.output.trim())?.[1] : undefined;
  return version === undefined
    ? {
        status: "refused",
        message: `Octant could not read the Claude Code version on ${placement.serverName}.`,
      }
    : { status: "found", version };
}

/** Said when Claude Code on the server reports no sign-in for the server's login. */
export function claudeServerSignInRefusal(serverName: string): string {
  return `Claude Code isn't signed in on ${serverName}. Sign in there as the server's login, for example by running \`claude auth login\` in the Project terminal, then try again.`;
}

/**
 * Whether Claude Code is signed in on the server, from its own
 * `claude auth status --json` there, whose `loggedIn` says so. Nothing else
 * it prints is kept.
 */
export async function readClaudeSignInOnServer(
  placement: ProviderServerPlacement,
): Promise<ServerSignIn> {
  const ran = await placement.run([CLAUDE_SERVER_PROGRAM, "auth", "status", "--json"], {
    timeoutMs: SIGN_IN_TIMEOUT_MS,
  });
  if (ran.status === "unreachable") return { status: "refused", message: ran.message };
  // It exits 1 when signed out, still printing its answer.
  const status = parseAuthenticationStatus(ran.output);
  if (status === "authenticated") return { status: "signed-in" };
  if (status === "unauthenticated") return { status: "signed-out" };
  return {
    status: "refused",
    message: `Octant could not read whether Claude Code is signed in on ${placement.serverName}. Check \`claude auth status\` in the Project terminal; an older Claude Code may need an update.`,
  };
}

/**
 * Whether the server holds the transcript of a Claude Code session started in
 * the Project's folder, read there: this host's account directory names
 * nothing on the server. Claude Code keys a session's folder by the canonical
 * working directory (`claudeProjectFolderName`), so the server's own `pwd -P`
 * names it, and its configuration directory is `CLAUDE_CONFIG_DIR` or
 * `~/.claude` as the login resolves them.
 */
export async function claudeSessionOnServer(
  placement: ProviderServerPlacement,
  sessionId: string,
): Promise<
  | { readonly status: "found" }
  | { readonly status: "missing" }
  | { readonly status: "unreachable"; readonly message: string }
> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return { status: "missing" };
  const ran = await placement.run(
    [
      "sh",
      "-c",
      'pwd -P && for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl; do [ -f "$f" ] && printf "%s\\n" "$f"; done; exit 0',
      "sh",
      sessionId,
    ],
    { timeoutMs: SESSION_LOOKUP_TIMEOUT_MS },
  );
  if (ran.status === "unreachable") return { status: "unreachable", message: ran.message };
  if (ran.exitCode !== 0) return { status: "missing" };
  const [folder, ...transcripts] = ran.output.split("\n").filter((line) => line !== "");
  if (folder === undefined) return { status: "missing" };
  const expected = `/projects/${claudeProjectFolderName(folder.normalize("NFC"))}/${sessionId}.jsonl`;
  return transcripts.some((path) => path.endsWith(expected))
    ? { status: "found" }
    : { status: "missing" };
}

/** The command a placed launch runs on the server: `env` with the forwarded switches, then `claude`. */
export function claudeServerProgram(spawnOptions: SpawnOptions): ReadonlyArray<string> {
  const credentials = CREDENTIAL_VARIABLES.map((name) => spawnOptions.env[name]).filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  if (credentials.some((value) => spawnOptions.args.some((arg) => arg.includes(value)))) {
    throw new Error("Claude process arguments must not contain credentials.");
  }
  const switches = FORWARDED_SWITCHES.flatMap((name) => {
    const value = spawnOptions.env[name];
    return value !== undefined && SWITCH_VALUE.test(value) ? [`${name}=${value}`] : [];
  });
  // The SDK puts the executable it was given first only for a script; a
  // placed launch names `claude`, so its arguments are the CLI's own.
  return ["env", ...switches, CLAUDE_SERVER_PROGRAM, ...spawnOptions.args];
}

/**
 * Starts the SDK's Claude Code launch on the server and hands the SDK the
 * process shape it expects. The process has no pid on this host, so nothing
 * here registers one; stopping it closes its standard input and then the
 * connection. Its standard error is drained and counted, as a local launch's
 * is, because the SDK reads only standard output.
 */
export function spawnClaudeOnServer(
  spawnOptions: SpawnOptions,
  placement: ProviderServerPlacement,
  options: {
    readonly stderrBytes: number;
    readonly onDiagnostic?: ((message: string) => void) | undefined;
  },
): SpawnedProcess {
  const stream = placement.start(claudeServerProgram(spawnOptions));
  if (stream.status === "unreachable") throw new Error(stream.message);
  const events = new EventEmitter();
  let exitCode: number | null = null;
  let stopped = false;
  let stderrBytes = 0;
  let stderrTruncated = false;
  stream.stderr.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    const captured = Math.min(bytes, Math.max(0, options.stderrBytes - stderrBytes));
    stderrBytes += captured;
    if (captured < bytes) stderrTruncated = true;
  });
  stream.stderr.once("close", () => {
    if (stderrBytes === 0) return;
    try {
      options.onDiagnostic?.(
        `Claude runtime on ${placement.serverName} wrote to stderr (${stderrBytes} bytes${stderrTruncated ? ", truncated" : ""}).`,
      );
    } catch {
      // A diagnostic sink that throws changes nothing about the session.
    }
  });
  const stop = () => {
    const first = !stopped;
    stopped = true;
    if (first) stream.stop();
    return first;
  };
  const onAbort = () => {
    stop();
  };
  spawnOptions.signal.addEventListener("abort", onAbort, { once: true });
  if (spawnOptions.signal.aborted) stop();
  void stream.exited.then(
    (exited) => {
      spawnOptions.signal.removeEventListener("abort", onAbort);
      exitCode = exited.exitCode ?? 1;
      events.emit("exit", exitCode, null);
    },
    () => {
      spawnOptions.signal.removeEventListener("abort", onAbort);
      exitCode = 1;
      events.emit("error", new Error(`The connection to ${placement.serverName} failed.`));
      events.emit("exit", exitCode, null);
    },
  );
  return {
    stdin: stream.stdin,
    stdout: stream.stdout,
    get killed() {
      return stopped;
    },
    get exitCode() {
      return exitCode;
    },
    signalCode: null,
    kill: () => stop(),
    on(event, listener) {
      events.on(event, listener);
    },
    once(event, listener) {
      events.once(event, listener);
    },
    off(event, listener) {
      events.off(event, listener);
    },
  };
}
