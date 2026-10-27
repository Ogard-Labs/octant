import { accessSync, constants, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  SSH_EXECUTOR_MAX_TERMINAL_CHUNK_BYTES,
  SSH_EXECUTOR_MAX_TERMINALS,
  SSH_EXECUTOR_TERMINAL_WINDOW_BYTES,
  type SshExecutorFrame,
  type SshExecutorOpenTerminalRequest,
  type SshExecutorTerminalHostFrame,
  type SshExecutorTerminalOpenedReply,
  type SshExecutorTerminalUnavailableReply,
} from "@octant/contracts/ssh-executor-protocol";
import type { PtyForkOptions, PtyProcess } from "../code/terminalProcessPort";
import { gitLinkedWorktreeMetadataPaths } from "../process/gitSeatbeltLaunch";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import { postureGrants } from "./executorAttestation";

/**
 * The executor's terminals: a person's interactive shell on a pseudo-terminal
 * of the target, in the bound root or one of its managed worktrees.
 * Canonical: docs/design/remote-ssh-environments.md § Terminals and managed
 * worktrees.
 *
 * A shell runs as a harness command does: through this build's
 * ProcessConfinementPort with the grants its posture's canaries attested, its
 * environment built here on the target and its home an owner-only folder of
 * this session's, so nothing of the host's crosses and the remote user's own
 * dotfiles are not read. It has no egress proxy: it is offline, or on the
 * target's own network in Full access only. Its output travels in frames the
 * host grants room for, and the shell is held while the host has not taken
 * its output off, so one flooding terminal holds a bounded amount and starves
 * nothing else on the session. Every shell dies with the session.
 */

const POSIX_SHELL = "/bin/sh";
const CLOSE_GRACE_MS = 1_000;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export type ExecutorPtySpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: PtyForkOptions,
) => PtyProcess;

export interface ExecutorTerminalEnvironment {
  readonly platform: NodeJS.Platform;
  /** This session's owner-only directory; without it no terminal opens. */
  readonly sessionDirectory: string | undefined;
  /** The remote user's login shell, as the executor's environment names it. */
  readonly shell: string | undefined;
  readonly path: string | undefined;
  readonly language: string | undefined;
  readonly confinement?: ProcessConfinementPort;
  readonly bwrapPath?: string;
  /**
   * Opens a pseudo-terminal. Defaults to node-pty, loaded only when a
   * terminal opens, so an executor without it still answers everything else.
   */
  readonly loadSpawn?: () => Promise<ExecutorPtySpawn | undefined>;
}

interface OpenTerminal {
  readonly id: number;
  readonly pty: PtyProcess;
  readonly stateDirectory: string;
  /** Output the host has room for, before it grants more. */
  window: number;
  /** Output waiting for room, in order. */
  pending: Buffer[];
  paused: boolean;
  exitCode: number | undefined;
  exited: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

const unavailable: SshExecutorTerminalUnavailableReply = { kind: "terminal-unavailable" };

export class ExecutorTerminals {
  readonly #send: (frame: SshExecutorFrame) => void;
  readonly #environment: ExecutorTerminalEnvironment;
  readonly #terminals = new Map<number, OpenTerminal>();
  #highest = 0;
  #ended = false;

  constructor(send: (frame: SshExecutorFrame) => void, environment: ExecutorTerminalEnvironment) {
    this.#send = send;
    this.#environment = environment;
  }

  /** Opens a shell in `root`, which the caller resolved as the bound root or a worktree of it. */
  async open(
    root: string,
    request: SshExecutorOpenTerminalRequest,
  ): Promise<SshExecutorTerminalOpenedReply | SshExecutorTerminalUnavailableReply> {
    // Each terminal's id is new, so a late frame of a closed one is never
    // read as a newer one's.
    if (request.terminal <= this.#highest || this.#ended) return unavailable;
    this.#highest = request.terminal;
    if (this.#terminals.size >= SSH_EXECUTOR_MAX_TERMINALS) return unavailable;
    const session = this.#environment.sessionDirectory;
    if (session === undefined) return unavailable;
    const spawnPty = await (this.#environment.loadSpawn ?? loadNodePty)();
    if (spawnPty === undefined || this.#ended) return unavailable;
    const stateDirectory = join(session, "terminals", String(request.terminal));
    const work = join(session, "work");
    let launch: { readonly command: string; readonly args: ReadonlyArray<string> };
    const shell = loginShell(this.#environment.shell);
    try {
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(work, { recursive: true, mode: 0o700 });
      const base =
        this.#environment.confinement ??
        makeProcessConfinementLive({
          platform: this.#environment.platform,
          ...(this.#environment.bwrapPath === undefined
            ? {}
            : { sandboxPath: this.#environment.bwrapPath }),
        });
      // A managed worktree keeps its Git record in the repository's own
      // `.git`, outside the worktree; Git's reciprocal record is what grants
      // it, as for a local linked worktree.
      const linked = gitLinkedWorktreeMetadataPaths(root, { writable: true });
      launch = base.prepare({
        executable: shell,
        args: ["-l"],
        boundRoot: root,
        temporaryDirectory: work,
        networkEgress: request.network === "allow" ? "allow" : "none",
        allowFileReadStar: true,
        readRoots: [root, work, stateDirectory, dirname(shell), ...linked.readPaths],
        additionalWriteRoots: [stateDirectory, ...linked.writePaths],
        terminal: { shellStateDirectory: stateDirectory },
        // Full access launches as it does on this host: with the writing
        // postures' grants. Whatever else the launch asks for, these are the
        // grants the posture's canaries attested.
        ...postureGrants(request.posture === "full-access" ? "auto-accept-edits" : request.posture),
      });
    } catch {
      rmSync(stateDirectory, { recursive: true, force: true });
      return unavailable;
    }
    let pty: PtyProcess;
    try {
      pty = spawnPty(launch.command, [...launch.args], {
        name: "xterm-256color",
        cwd: root,
        env: {
          TERM: "xterm-256color",
          HOME: stateDirectory,
          PATH: this.#environment.path ?? DEFAULT_PATH,
          LANG: this.#environment.language ?? "C.UTF-8",
          TMPDIR: work,
          HISTFILE: join(stateDirectory, "history"),
          XDG_CACHE_HOME: join(stateDirectory, "cache"),
          XDG_STATE_HOME: join(stateDirectory, "state"),
        },
        cols: request.columns,
        rows: request.rows,
      });
    } catch {
      rmSync(stateDirectory, { recursive: true, force: true });
      return unavailable;
    }
    const terminal: OpenTerminal = {
      id: request.terminal,
      pty,
      stateDirectory,
      window: SSH_EXECUTOR_TERMINAL_WINDOW_BYTES,
      pending: [],
      paused: false,
      exitCode: undefined,
      exited: false,
      killTimer: undefined,
    };
    this.#terminals.set(terminal.id, terminal);
    pty.onData((data) => {
      if (this.#terminals.get(terminal.id) !== terminal) return;
      terminal.pending.push(Buffer.from(data, "utf8"));
      this.#flush(terminal);
    });
    pty.onExit(({ exitCode }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      clearTimeout(terminal.killTimer);
      this.#flush(terminal);
    });
    return { kind: "terminal-opened" };
  }

  receive(frame: SshExecutorTerminalHostFrame): "accepted" {
    // A frame for a terminal that already ended can still be in flight.
    const terminal = this.#terminals.get(frame.terminal);
    if (terminal === undefined) return "accepted";
    // A shell that exited still sends what it printed, so it still takes room;
    // nothing else reaches it.
    if (terminal.exited && frame.type !== "terminal-credit") return "accepted";
    switch (frame.type) {
      case "terminal-input":
        try {
          terminal.pty.write(Buffer.from(frame.data, "base64").toString("utf8"));
        } catch {
          // The shell exited between the frame and the write; its exit is sent.
        }
        return "accepted";
      case "terminal-resize":
        try {
          terminal.pty.resize(frame.columns, frame.rows);
        } catch {
          // As above.
        }
        return "accepted";
      case "terminal-close":
        this.#kill(terminal, "SIGHUP");
        terminal.killTimer ??= setTimeout(() => this.#kill(terminal, "SIGKILL"), CLOSE_GRACE_MS);
        return "accepted";
      case "terminal-credit":
        terminal.window = Math.min(
          SSH_EXECUTOR_TERMINAL_WINDOW_BYTES,
          terminal.window + frame.bytes,
        );
        this.#flush(terminal);
        return "accepted";
    }
  }

  /** The session is gone: every shell ends, and nothing is sent. */
  abandon(): void {
    this.#ended = true;
    for (const terminal of this.#terminals.values()) {
      this.#kill(terminal, "SIGKILL");
      clearTimeout(terminal.killTimer);
      rmSync(terminal.stateDirectory, { recursive: true, force: true });
    }
    this.#terminals.clear();
  }

  /**
   * Sends what the host has room for and holds the shell while output waits;
   * once a shell that exited has sent all it printed, says so and forgets it.
   */
  #flush(terminal: OpenTerminal): void {
    if (this.#ended) return;
    while (terminal.window > 0 && terminal.pending.length > 0) {
      const head = terminal.pending[0];
      if (head === undefined) break;
      const size = Math.min(
        head.byteLength,
        terminal.window,
        SSH_EXECUTOR_MAX_TERMINAL_CHUNK_BYTES,
      );
      this.#send({
        type: "terminal-output",
        terminal: terminal.id,
        data: head.subarray(0, size).toString("base64"),
      });
      terminal.window -= size;
      if (size === head.byteLength) terminal.pending.shift();
      else terminal.pending[0] = head.subarray(size);
    }
    const waiting = terminal.pending.length > 0;
    if (!terminal.exited && waiting !== terminal.paused) {
      terminal.paused = waiting;
      try {
        if (waiting) terminal.pty.pause();
        else terminal.pty.resume();
      } catch {
        // A shell that is exiting needs no flow control.
      }
    }
    if (terminal.exited && !waiting && this.#terminals.get(terminal.id) === terminal) {
      this.#terminals.delete(terminal.id);
      rmSync(terminal.stateDirectory, { recursive: true, force: true });
      this.#send({
        type: "terminal-exited",
        terminal: terminal.id,
        ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
      });
    }
  }

  /** Signals the shell's whole process group, so nothing it started outlives it. */
  #kill(terminal: OpenTerminal, signal: NodeJS.Signals): void {
    try {
      process.kill(-terminal.pty.pid, signal);
    } catch {
      try {
        process.kill(terminal.pty.pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
}

/** The remote user's login shell when it is an executable absolute path, else `/bin/sh`. */
function loginShell(shell: string | undefined): string {
  if (shell === undefined || !isAbsolute(shell)) return POSIX_SHELL;
  try {
    accessSync(shell, constants.X_OK);
    return statSync(shell).isFile() ? shell : POSIX_SHELL;
  } catch {
    return POSIX_SHELL;
  }
}

async function loadNodePty(): Promise<ExecutorPtySpawn | undefined> {
  try {
    const nodePty = await import("node-pty");
    return (command, args, options) => nodePty.spawn(command, [...args], { ...options });
  } catch {
    return undefined;
  }
}
