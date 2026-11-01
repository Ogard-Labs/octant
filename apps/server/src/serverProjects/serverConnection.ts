import { spawn } from "node:child_process";

/**
 * One call on a registered server, over this host's own `ssh`. Canonical:
 * docs/design/server-projects.md § Connection.
 *
 * The person's SSH config, known hosts, and agent decide how the server is
 * reached and how the login is signed: Octant names no key file, writes no
 * config, and forwards nothing. Every call is its own connection, and a call
 * that cannot reach the server is `unreachable`; nothing about a server
 * Project ever runs on this host instead.
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
}

/** Written first by every call, so a call that never printed it never reached the server. */
const SENTINEL = 0x1e;

/**
 * The options every connection runs with, after the person's config: no
 * prompt, no new or changed host key accepted, nothing forwarded either way,
 * no local command, and no shared control socket. A silent connection ends
 * after about thirty seconds.
 */
export const SERVER_CONNECTION_OPTIONS: ReadonlyArray<string> = [
  "BatchMode=yes",
  "StrictHostKeyChecking=yes",
  "UpdateHostKeys=no",
  "ForwardAgent=no",
  "ForwardX11=no",
  "ClearAllForwardings=yes",
  "PermitLocalCommand=no",
  "ControlMaster=no",
  "ControlPath=none",
  "ConnectTimeout=10",
  "ServerAliveInterval=10",
  "ServerAliveCountMax=3",
  "LogLevel=ERROR",
];

/** Single-quotes a word for the remote login shell. */
export function quoteForServer(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The `ssh` arguments for one call, the remote command last. */
export function serverSshArguments(
  server: ServerAddress,
  remoteCommand: string | undefined,
  options: { readonly terminal: boolean; readonly configFile?: string | undefined },
): ReadonlyArray<string> {
  return [
    ...(options.configFile === undefined ? [] : ["-F", options.configFile]),
    ...SERVER_CONNECTION_OPTIONS.flatMap((option) => ["-o", option]),
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
    const remoteCommand = [
      "sh",
      "-c",
      quoteForServer(`printf '\\036'; ${input.script}`),
      "octant",
      ...(input.args ?? []).map(quoteForServer),
    ].join(" ");
    const args = serverSshArguments(server, remoteCommand, {
      terminal,
      configFile: this.#options.configFile,
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
        // ssh exits 255 for its own failures. Its messages are the only thing
        // on its standard error once the script sends its own elsewhere, so
        // 255 with a message is a dropped or refused connection, and a call
        // that never printed the sentinel never reached the server at all.
        const message = lastLine(errorText);
        if (!reached || (code === 255 && message !== undefined)) {
          finish({
            status: "unreachable",
            message: message ?? "The connection closed before the server answered.",
          });
          return;
        }
        finish({ status: "ran", exitCode: code ?? 1, output, truncated });
      });
    });
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
