import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { SERVER_CONTROL_SOCKET_PREFIX } from "../process/seatbeltProfile";

/**
 * One call on a registered server, over this host's own `ssh`. Canonical:
 * docs/design/server-projects.md § Connection.
 *
 * The person's SSH config, known hosts, and agent decide how the server is
 * reached and how the login is signed: Octant names no key file, writes no
 * config, and forwards nothing. Calls to one server share one connection
 * through a control socket only this host's user can open, and a call that
 * cannot reach the server is `unreachable`; nothing about a server Project
 * ever runs on this host instead.
 */

/** The registered server a call goes to: its SSH config alias and login user. */
export interface ServerAddress {
  readonly alias: string;
  readonly user: string;
}

export type ServerCall =
  | {
      readonly status: "ran";
      readonly exitCode: number;
      readonly output: Buffer;
      readonly truncated: boolean;
      /** The first few kilobytes of standard error, empty on a terminal. */
      readonly errorOutput: string;
    }
  | {
      readonly status: "timed-out" | "cancelled";
      readonly output: Buffer;
      readonly truncated: boolean;
    }
  /** The server could not be reached, or the connection dropped; `message` says what ssh reported. */
  | { readonly status: "unreachable"; readonly message: string };

export interface ServerCallInput {
  /** A POSIX `sh` script; its arguments arrive as `$1`, `$2`, …. */
  readonly script: string;
  readonly args?: ReadonlyArray<string>;
  readonly stdin?: Buffer;
  /**
   * Runs the script on a terminal on the server, so it is hung up with the
   * connection when a call is cancelled or times out. Its output is then the
   * terminal's, standard error included, with `\r\n` turned back to `\n`.
   */
  readonly terminal?: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface ServerConnectionOptions {
  readonly sshPath?: string;
  /** The person's SSH agent socket, read each call. */
  readonly agentSocket: () => string | undefined;
  /** An SSH config file in place of the person's own. Tests only: production reads the person's. */
  readonly configFile?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * The private folder the shared connections' control sockets live in,
   * made on first use. A socket path must stay under 104 bytes, so it is a
   * short folder under `/tmp` by default.
   */
  readonly controlDirectory?: () => string;
}

/** Written first by every call, so a call that never printed it never reached the server. */
const SENTINEL = 0x1e;

/**
 * The options every connection runs with, after the person's config: no
 * prompt, no new or changed host key accepted, nothing forwarded either way,
 * and no local command. A silent connection ends after about thirty seconds.
 * The control socket is set per call: none for a terminal, or the shared
 * connection's own.
 */
export const SERVER_CONNECTION_OPTIONS: ReadonlyArray<string> = [
  "BatchMode=yes",
  "StrictHostKeyChecking=yes",
  "UpdateHostKeys=no",
  "ForwardAgent=no",
  "ForwardX11=no",
  "ClearAllForwardings=yes",
  "PermitLocalCommand=no",
  "ConnectTimeout=10",
  "ServerAliveInterval=10",
  "ServerAliveCountMax=3",
  "LogLevel=ERROR",
];

/** Bytes every shell reads literally inside single quotes; anything else travels as an octal escape. */
const PLAIN_WIRE_BYTES = /^[A-Za-z0-9_./ -]$/;

/**
 * Raw bytes in one word on the wire, at most five encoded bytes each. csh
 * refuses a word past about 8 KiB (measured on Debian's csh: "Word too long").
 */
const WIRE_CHUNK_BYTES = 1_500;

/**
 * One value as words no login shell can misread: single-quoted, holding only
 * plain bytes and `\0ooo` escapes for `printf %b` on the server, then an empty
 * word that ends the value. There is no quote, newline, `!`, `$`, or doubled
 * backslash in them for a shell to act on.
 */
function encodedWords(value: string): ReadonlyArray<string> {
  const bytes = Buffer.from(value, "utf8");
  const words: string[] = [];
  for (let at = 0; at < bytes.length; at += WIRE_CHUNK_BYTES) {
    let encoded = "";
    for (const byte of bytes.subarray(at, at + WIRE_CHUNK_BYTES)) {
      const character = String.fromCharCode(byte);
      encoded += PLAIN_WIRE_BYTES.test(character)
        ? character
        : `\\0${byte.toString(8).padStart(3, "0")}`;
    }
    words.push(`'${encoded}'`);
  }
  words.push("''");
  return words;
}

/**
 * Decodes the words into values, keeping trailing newlines, then runs the
 * first value as a script with the rest as `$1`, `$2`, …. A fixed text with
 * no single quote, backslash, newline, or `!`, so every login shell hands it
 * to `sh` unchanged.
 */
const SERVER_DECODER =
  'n=$#;w=;while [ "$n" -gt 0 ];do if [ -z "$1" ];then set -- "$@" "$w";w=;else v=$(printf %b "$1";printf x);w=$w${v%x};fi;shift;n=$((n-1));done;s=$1;shift;exec sh -c "$s" octant "$@"';

/**
 * The text ssh hands to the person's login shell for one script. Agent text
 * never reaches that shell as text it parses: quoting rules differ by shell
 * (measured on fish 3.6: `\'` inside single quotes closed the word and ran
 * what followed, with no approval; csh and tcsh ran a backtick and rejected a
 * newline there), so the script and arguments are encoded and only `sh`
 * decodes them. Canonical: docs/design/server-projects.md § Connection.
 */
export function serverRemoteCommand(script: string, args: ReadonlyArray<string> = []): string {
  return [
    "sh",
    "-c",
    `'${SERVER_DECODER}'`,
    "octant",
    ...[script, ...args].flatMap(encodedWords),
  ].join(" ");
}

/**
 * What one exec's argument can hold on Linux is 128 KiB, and the whole remote
 * command is one argument to the login shell. Past it the call is refused
 * here with a plain reason instead of failing on the server.
 */
const MAX_REMOTE_COMMAND_BYTES = 120 * 1024;

/** How long a shared connection stays open after its last call. */
const SHARED_CONNECTION_IDLE_SECONDS = 60;

/**
 * The `ssh` arguments for one call, the remote command last. With a
 * `controlSocket`, the call rides that server's shared connection, starting
 * it when none is open; without one it is a connection of its own.
 */
export function serverSshArguments(
  server: ServerAddress,
  remoteCommand: string | undefined,
  options: {
    readonly terminal: boolean;
    readonly configFile?: string | undefined;
    readonly controlSocket?: string | undefined;
  },
): ReadonlyArray<string> {
  const control =
    options.controlSocket === undefined
      ? ["ControlMaster=no", "ControlPath=none"]
      : [
          "ControlMaster=auto",
          `ControlPath=${options.controlSocket}`,
          `ControlPersist=${String(SHARED_CONNECTION_IDLE_SECONDS)}`,
        ];
  return [
    ...(options.configFile === undefined ? [] : ["-F", options.configFile]),
    ...[...SERVER_CONNECTION_OPTIONS, ...control].flatMap((option) => ["-o", option]),
    options.terminal ? "-tt" : "-T",
    "-l",
    server.user,
    "--",
    server.alias,
    ...(remoteCommand === undefined ? [] : [remoteCommand]),
  ];
}

/**
 * The environment `ssh` runs with: enough to find the person's config and
 * agent, and nothing of this host's own secrets.
 */
export function serverSshEnvironment(
  inherited: NodeJS.ProcessEnv,
  agentSocket: string | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"]) {
    const value = inherited[name];
    if (value !== undefined) environment[name] = value;
  }
  if (agentSocket !== undefined) environment.SSH_AUTH_SOCK = agentSocket;
  return environment;
}

export class ServerConnection {
  readonly #options: ServerConnectionOptions;
  #controlDirectory: string | undefined;

  constructor(options: ServerConnectionOptions) {
    this.#options = options;
  }

  /** The command and arguments of an interactive login on the server, for a terminal. */
  loginCommand(
    server: ServerAddress,
    remoteCommand: string,
  ): {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly environment: NodeJS.ProcessEnv;
  } {
    return {
      command: this.#options.sshPath ?? "ssh",
      args: serverSshArguments(server, remoteCommand, {
        terminal: true,
        configFile: this.#options.configFile,
      }),
      environment: this.#environment(),
    };
  }

  run(server: ServerAddress, input: ServerCallInput): Promise<ServerCall> {
    const terminal = input.terminal === true;
    const words = input.args ?? [];
    // A NUL cannot travel in a server argument: the decoder would drop it and
    // hand the script a different word than the one this host judged.
    if ([input.script, ...words].some((word) => word.includes("\0"))) {
      return Promise.resolve({
        status: "unreachable",
        message: "This call holds a NUL byte, which no server command can carry. Nothing ran.",
      });
    }
    const remoteCommand = serverRemoteCommand(
      // The script runs in a subshell whose own 255 becomes 254, so 255 is
      // only ever ssh reporting its own failure.
      `printf '\\036'; (${input.script}\n); status=$?; [ "$status" -eq 255 ] && status=254; exit "$status"`,
      words,
    );
    if (remoteCommand.length > MAX_REMOTE_COMMAND_BYTES) {
      return Promise.resolve({
        status: "unreachable",
        message: "This call is too long to send to the server. Nothing ran.",
      });
    }
    let controlSocket: string;
    try {
      controlSocket = this.#controlSocket(server);
    } catch {
      return Promise.resolve({
        status: "unreachable",
        message: "Octant could not make the folder its server connections share.",
      });
    }
    const args = serverSshArguments(server, remoteCommand, {
      terminal,
      configFile: this.#options.configFile,
      controlSocket,
    });
    return new Promise((resolve) => {
      if (input.signal?.aborted === true) {
        resolve({ status: "cancelled", output: Buffer.alloc(0), truncated: false });
        return;
      }
      const child = spawn(this.#options.sshPath ?? "ssh", [...args], {
        env: this.#environment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let received = 0;
      let truncated = false;
      let reached = false;
      let errorText = "";
      let ended: "timed-out" | "cancelled" | undefined;
      const stop = (why: "timed-out" | "cancelled") => {
        if (ended !== undefined) return;
        ended = why;
        child.kill("SIGTERM");
      };
      const timer = setTimeout(() => stop("timed-out"), input.timeoutMs);
      const onAbort = () => stop("cancelled");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        let data = chunk;
        if (!reached) {
          const at = data.indexOf(SENTINEL);
          if (at === -1) return;
          reached = true;
          data = data.subarray(at + 1);
        }
        if (truncated) return;
        const room = input.maxOutputBytes - received;
        if (data.length > room) {
          chunks.push(data.subarray(0, room));
          received += room;
          truncated = true;
          return;
        }
        chunks.push(data);
        received += data.length;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errorText.length < 4_096) errorText += chunk.toString("utf8");
      });
      child.stdin.on("error", () => undefined);
      if (input.stdin !== undefined) child.stdin.end(input.stdin);
      else if (!terminal) child.stdin.end();
      const finish = (result: ServerCall) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      child.on("error", (error) => finish({ status: "unreachable", message: error.message }));
      child.on("close", (code) => {
        const raw = Buffer.concat(chunks);
        const output = terminal ? Buffer.from(raw.toString("utf8").replaceAll("\r\n", "\n")) : raw;
        if (ended !== undefined) {
          finish({ status: ended, output, truncated });
          return;
        }
        // ssh exits 255 for its own failures, and the wrapper keeps the
        // script from exiting 255, so 255 is a refused or dropped connection
        // even when ssh printed nothing (a server that ends the session is
        // reported below the error log level). A call that never printed
        // the sentinel never reached the server at all.
        const message = lastLine(errorText);
        if (!reached || code === 255) {
          finish({
            status: "unreachable",
            message: message ?? "The connection closed before the server answered.",
          });
          return;
        }
        finish({ status: "ran", exitCode: code ?? 1, output, truncated, errorOutput: errorText });
      });
    });
  }

  /**
   * One socket per server and user, in a folder only this host's user can
   * open, so a later call reuses the login instead of making its own. Every
   * confined launch is denied the folder's sockets.
   */
  #controlSocket(server: ServerAddress): string {
    this.#controlDirectory ??=
      this.#options.controlDirectory?.() ?? mkdtempSync(SERVER_CONTROL_SOCKET_PREFIX);
    const name = createHash("sha256")
      .update(`${server.user}\0${server.alias}`)
      .digest("hex")
      .slice(0, 16);
    return `${this.#controlDirectory}/${name}`;
  }

  #environment(): NodeJS.ProcessEnv {
    return serverSshEnvironment(
      this.#options.environment ?? process.env,
      this.#options.agentSocket(),
    );
  }
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1);
}
