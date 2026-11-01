import { homedir } from "node:os";
import {
  MAX_TERMINAL_INPUT_BYTES,
  spawnHostPty,
  type PtyProcess,
  type TerminalProcessHandle,
} from "../code/terminalProcessPort";
import { quoteForServer, type ServerAddress, type ServerConnection } from "./serverConnection";

/**
 * A terminal in a server Project: an interactive login on the server, in the
 * Project's folder, through the same connection rules as every other call.
 * Canonical: docs/design/server-projects.md § Threads.
 *
 * The pseudo-terminal on this host runs only `ssh`; the person's shell runs
 * on the server. When the connection drops, ssh exits and the terminal ends
 * with it; nothing restarts it here.
 */

export interface ServerTerminalLogin {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

const CLOSE_GRACE_MS = 2_000;

/** The ssh login that opens the person's own shell in `folder` on the server. */
export function serverTerminalLogin(
  connection: Pick<ServerConnection, "loginCommand">,
  server: ServerAddress,
  folder: string,
): ServerTerminalLogin {
  return connection.loginCommand(
    server,
    // The login shell runs this, then the person's own shell replaces it.
    `cd -- ${quoteForServer(folder)} && exec "\${SHELL:-/bin/sh}" -l`,
  );
}

export function startServerTerminal(
  login: ServerTerminalLogin,
  geometry: { readonly columns: number; readonly rows: number },
  spawn: (
    command: string,
    args: readonly string[],
    options: Parameters<typeof spawnHostPty>[2],
  ) => PtyProcess = spawnHostPty,
): TerminalProcessHandle {
  const environment: Record<string, string> = { TERM: "xterm-256color" };
  for (const [name, value] of Object.entries(login.environment)) {
    if (value !== undefined) environment[name] = value;
  }
  const pty = spawn(login.command, login.args, {
    name: "xterm-256color",
    cwd: homedir(),
    env: environment,
    cols: geometry.columns,
    rows: geometry.rows,
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    pty.onExit(() => {
      exited = true;
      resolve();
    });
  });
  return {
    write: (data) => {
      if (Buffer.byteLength(data, "utf8") > MAX_TERMINAL_INPUT_BYTES) {
        throw new Error("Terminal input is too large.");
      }
      pty.write(data);
    },
    resize: (columns, rows) => pty.resize(columns, rows),
    onData: (listener) => {
      const disposable = pty.onData(listener);
      return () => disposable.dispose();
    },
    onExit: (listener) => {
      const disposable = pty.onExit(listener);
      return () => disposable.dispose();
    },
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    close: async () => {
      if (exited) return;
      try {
        process.kill(pty.pid, "SIGTERM");
      } catch {
        return;
      }
      const ended = await Promise.race([
        exit.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE_MS)),
      ]);
      if (!ended) {
        try {
          process.kill(pty.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  };
}
