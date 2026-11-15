import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  | { readonly status: "unreachable"; readonly message: string; readonly errorOutput?: string };

export interface ServerCallInput {
  /** A POSIX `sh` script; its arguments arrive as `$1`, `$2`, …. */
  readonly script: string;
  /** Rechecks SSH identity and login without a cached control connection. Setup diagnostics only. */
  readonly freshConnection?: true;
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
  /**
   * Host keys the host pinned for a server, read each call: a machine Octant
   * created in the person's cloud account, whose provider reported them.
   * When present they are the only keys that server's connection accepts.
   */
  readonly pinnedHostKeys?: (server: ServerAddress) => ReadonlyArray<string> | undefined;
  /** Why no call may go to a server now (its machine is suspended), read each call. */
  readonly refuses?: (server: ServerAddress) => string | undefined;
}

/** The name a pinned server's keys are recorded under, so its alias never has to be a host pattern. */
const PINNED_HOST_KEY_ALIAS = "octant-pinned-host";

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
    /** A known hosts file holding only the server's pinned keys. */
    readonly pinnedKnownHosts?: string | undefined;
  },
): ReadonlyArray<string> {
  const control =
    options.controlSocket === undefined
      ? ["ControlMaster=no", "ControlPath=none", "ControlPersist=no"]
      : [
          "ControlMaster=auto",
          `ControlPath=${options.controlSocket}`,
          `ControlPersist=${String(SHARED_CONNECTION_IDLE_SECONDS)}`,
        ];
  return [
    ...(options.configFile === undefined ? [] : ["-F", options.configFile]),
    ...[
      ...SERVER_CONNECTION_OPTIONS,
      ...pinnedHostKeyOptions(options.pinnedKnownHosts),
      ...control,
    ].flatMap((option) => ["-o", option]),
    options.terminal ? "-tt" : "-T",
    "-l",
    server.user,
    "--",
    server.alias,
    ...(remoteCommand === undefined ? [] : [remoteCommand]),
  ];
}

/**
 * Checks the host key against the pinned file alone, under a fixed alias.
 * A command-line option wins over the person's config, so neither their
 * known hosts, a `KnownHostsCommand`, DNS (`VerifyHostKeyDNS`), nor a
 * `HostKeyAlias` of theirs can stand in for the pin (`UpdateHostKeys=no` is
 * already on every connection), and
 * strict checking still refuses any key the file does not hold.
 */
export function pinnedHostKeyOptions(pinnedKnownHosts: string | undefined): ReadonlyArray<string> {
  if (pinnedKnownHosts === undefined) return [];
  return [
    `UserKnownHostsFile="${pinnedKnownHosts}"`,
    "GlobalKnownHostsFile=none",
    // A command of the person's could vouch for another key; OpenSSH before
    // 8.5 rejects the option, which refuses the call rather than skip the pin.
    "KnownHostsCommand=none",
    // With the person's VerifyHostKeyDNS=yes, OpenSSH accepts a key matching a
    // DNSSEC-signed SSHFP record before it reads any known hosts file, so DNS
    // could vouch for a key the pin does not hold.
    "VerifyHostKeyDNS=no",
    // The address is checked against known hosts files too; only the pin decides.
    "CheckHostIP=no",
    `HostKeyAlias=${PINNED_HOST_KEY_ALIAS}`,
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
  /** What each pinned file holds now, so an unchanged pin is not rewritten on every call. */
  readonly #pinnedWritten = new Map<string, string>();

  constructor(options: ServerConnectionOptions) {
    this.#options = options;
  }

  /** Why no call may go to this server now, or nothing. */
  refusal(server: ServerAddress): string | undefined {
    return this.#options.refuses?.(server);
  }

  /**
   * The known hosts file holding only this server's pinned keys, written to
   * the private folder the shared connections live in, or nothing when the
   * server has no pin. When a pinned server's file cannot be written it is
   * an empty file, so strict checking refuses every key rather than fall
   * back to the person's known hosts.
   */
  pinnedKnownHostsFile(
    server: ServerAddress,
    keys: ReadonlyArray<string> = this.#options.pinnedHostKeys?.(server) ?? [],
  ): string | undefined {
    if (keys.length === 0) return undefined;
    try {
      const path = `${this.#controlPath(serverDigest(server, keys))}.known_hosts`;
      const content = keys.map((key) => `${PINNED_HOST_KEY_ALIAS} ${key}\n`).join("");
      if (this.#pinnedWritten.get(path) !== content) {
        writeFileSync(path, content, { mode: 0o600 });
        this.#pinnedWritten.set(path, content);
      }
      return path;
    } catch {
      return "/dev/null";
    }
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
        pinnedKnownHosts: this.pinnedKnownHostsFile(server),
      }),
      environment: this.#environment(),
    };
  }

  run(server: ServerAddress, input: ServerCallInput): Promise<ServerCall> {
    const refusal = this.refusal(server);
    if (refusal !== undefined) return Promise.resolve({ status: "unreachable", message: refusal });
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
    // Read once, so the shared connection and the file it checks name one pin.
    const pinned = this.#options.pinnedHostKeys?.(server) ?? [];
    let controlSocket: string | undefined;
    try {
      if (input.freshConnection !== true) controlSocket = this.#controlSocket(server, pinned);
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
      pinnedKnownHosts: this.pinnedKnownHostsFile(server, pinned),
    });
    return new Promise((resolve) => {
      if (input.signal?.aborted === true) {
        resolve({ status: "cancelled", output: Buffer.alloc(0), truncated: false });
        return;
      }
      const child = spawn(this.#options.sshPath ?? "ssh", [...args], {
        env: { ...this.#environment(), ...(input.freshConnection === true ? { LC_ALL: "C" } : {}) },
        detached: input.freshConnection === true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let received = 0;
      let truncated = false;
      let reached = false;
      let errorText = "";
      let errorReceived = 0;
      let ended: "timed-out" | "cancelled" | undefined;
      let forceStop: ReturnType<typeof setTimeout> | undefined;
      const killOwned = (signal: NodeJS.Signals) => {
        if (
          input.freshConnection === true &&
          process.platform !== "win32" &&
          child.pid !== undefined
        ) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            /* Already exited. */
          }
        } else child.kill(signal);
      };
      const stop = (why: "timed-out" | "cancelled") => {
        if (ended !== undefined) return;
        ended = why;
        killOwned("SIGTERM");
        if (input.freshConnection === true) forceStop = setTimeout(() => killOwned("SIGKILL"), 250);
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
        const part = chunk.subarray(0, Math.max(0, 4_096 - errorReceived));
        errorReceived += part.length;
        errorText += part.toString("utf8");
      });
      child.stdin.on("error", () => undefined);
      if (input.stdin !== undefined) child.stdin.end(input.stdin);
      else if (!terminal) child.stdin.end();
      const finish = (result: ServerCall) => {
        clearTimeout(timer);
        clearTimeout(forceStop);
        if (input.freshConnection === true) killOwned("SIGKILL");
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
            errorOutput: errorText.slice(0, 4_096),
          });
          return;
        }
        finish({ status: "ran", exitCode: code ?? 1, output, truncated, errorOutput: errorText });
      });
    });
  }

  /**
   * One socket per server, user and pin, in a folder only this host's user can
   * open, so a later call reuses the login instead of making its own. Every
   * confined launch is denied the folder's sockets.
   */
  #controlSocket(server: ServerAddress, pinned: ReadonlyArray<string>): string {
    // The pinned keys are part of the socket's identity: a shared connection
    // already open trusted the host under the keys of its own login, and
    // reusing it after a pin is installed or changed would skip the new check.
    return this.#controlPath(serverDigest(server, pinned));
  }

  #controlPath(name: string): string {
    this.#controlDirectory ??=
      this.#options.controlDirectory?.() ?? mkdtempSync(SERVER_CONTROL_SOCKET_PREFIX);
    return `${this.#controlDirectory}/${name}`;
  }

  #environment(): NodeJS.ProcessEnv {
    return serverSshEnvironment(
      this.#options.environment ?? process.env,
      this.#options.agentSocket(),
    );
  }
}

/** A short name for a server and login, and the keys pinned for it, if any; a socket path stays under 104 bytes. */
function serverDigest(server: ServerAddress, pinned: ReadonlyArray<string> = []): string {
  const hash = createHash("sha256").update(`${server.user}\0${server.alias}`);
  if (pinned.length > 0) hash.update(`\0${pinned.join("\n")}`);
  return hash.digest("hex").slice(0, 16);
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1);
}
