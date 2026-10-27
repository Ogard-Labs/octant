import type { CodeTerminalId } from "@octant/contracts/code";
import {
  decodeProjectTerminalResult,
  type ProjectTerminalPosture,
  type ProjectTerminalRefusalReason,
  type ProjectTerminalResult,
} from "@octant/contracts/project-terminals";
import type { ProjectId } from "@octant/contracts/projects";
import type { WindowId } from "@octant/contracts/shell";
import type { SshRemoteTerminalCommand } from "@octant/contracts/ssh-remote-project";
import type { SshRemoteTerminalEndReason } from "@octant/contracts/ssh-target-events";
import { describeSshAdmissionRefusal } from "@octant/domain/ssh-target-recovery";
import type { TerminalProcessHandle } from "../code/terminalProcessPort";
import { TerminalService } from "../code/terminalService";
import type { ExecutorTerminal, ExecutorTerminalListener } from "./executorChannel";
import type { SshRemoteProjectService } from "./sshRemoteProjectService";
import type {
  SshTargetAdmissionRequest,
  SshTargetConnectionService,
} from "./sshTargetConnectionService";
import type { SshTargetStore } from "./sshTargetStore";

/**
 * Terminals a person opens on a remote-bound Project's target, in its remote
 * root or one of its managed worktrees. Canonical:
 * docs/design/remote-ssh-environments.md § Terminals and managed worktrees.
 *
 * It is a local Project terminal whose shell runs on the target: only the
 * window that opened it on this Mac can reach it, and it answers in the
 * local Project terminal's shape, so the same surface draws either. A shell
 * opens only when the admission policy admits one of Octant's own launches in
 * its posture on the current session, and it belongs to that session: when
 * the session ends the shell died with the executor, and the terminal ends as
 * `target-disconnected`. Nothing reconnects it or queues its input.
 *
 * A remote-bound Project has no remembered Full access, so its terminals run
 * approval-gated, and offline: a terminal has no thread whose egress rules a
 * proxy could decide its connections under, and a networked posture without
 * rules runs offline rather than open.
 */

const TERMINAL_POSTURE: ProjectTerminalPosture = "approval-gated";
const TERMINAL_ADMISSION: SshTargetAdmissionRequest = {
  posture: TERMINAL_POSTURE,
  permissionPersistence: "current-session",
  subject: { kind: "octant-launch" },
};
/** How long a stopped shell has to report its exit before it is taken as ended. */
const CLOSE_TIMEOUT_MS = 5_000;

export interface SshRemoteTerminalServiceOptions {
  readonly projects: Pick<SshRemoteProjectService, "folder">;
  readonly connections: Pick<SshTargetConnectionService, "openTerminal">;
  readonly store: Pick<
    SshTargetStore,
    "recordTerminalStarted" | "recordTerminalEnded" | "runningTerminals"
  >;
}

interface Owner {
  readonly terminalId: CodeTerminalId;
  readonly windowId: WindowId;
  readonly projectId: ProjectId;
  /** Why the shell ended, once something said so first. */
  ending: SshRemoteTerminalEndReason | undefined;
  journaled: boolean;
  stopObserving: (() => void) | undefined;
}

export class SshRemoteTerminalService {
  readonly #options: SshRemoteTerminalServiceOptions;
  readonly #owners = new Map<string, Owner>();
  /** A shell that opened, waiting for the terminal record that takes it. */
  readonly #opened = new Map<string, TerminalProcessHandle>();
  readonly #terminals: TerminalService;

  constructor(options: SshRemoteTerminalServiceOptions) {
    this.#options = options;
    // The transcript, readers, and redaction are a local terminal's own; only
    // where the shell runs differs, so the process each record starts is the
    // remote shell already opened for it.
    this.#terminals = new TerminalService({
      port: {
        start: (input) => {
          const handle = this.#opened.get(input.stateScope);
          this.#opened.delete(input.stateScope);
          if (handle === undefined)
            throw new Error("No remote shell was opened for this terminal.");
          return handle;
        },
      },
      inheritedEnvironment: {},
      credentials: {
        resolve: () => Promise.reject(new Error("A remote terminal is handed no credential.")),
      },
    });
  }

  /**
   * Ends every terminal the journal still records as running. A host restart
   * ended the session each shell ran on, and the shell with it.
   */
  reconcile(): void {
    for (const terminalId of this.#options.store.runningTerminals()) {
      if (this.#owners.has(String(terminalId))) continue;
      this.#options.store.recordTerminalEnded({ terminalId, reason: "host-restarted" });
    }
  }

  async execute(
    windowId: WindowId,
    command: SshRemoteTerminalCommand,
  ): Promise<ProjectTerminalResult> {
    if (command.kind === "start") return this.#start(windowId, command);
    const owner = this.#owners.get(String(command.terminalId));
    if (owner === undefined) {
      return refused("unavailable", "This terminal is not running on this host.");
    }
    if (
      String(owner.windowId) !== String(windowId) ||
      String(owner.projectId) !== String(command.projectId)
    ) {
      return refused("unauthorized", "This terminal belongs to another window or Project.");
    }
    try {
      switch (command.kind) {
        case "attach":
          return this.#view(owner, 0);
        case "read-output":
          return this.#view(owner, command.afterCharacters);
        case "write":
          this.#terminals.write(String(command.terminalId), command.data);
          return this.#view(owner);
        case "resize":
          this.#terminals.resize(String(command.terminalId), command.columns, command.rows);
          return this.#view(owner);
        case "stop":
          owner.ending ??= "stopped";
          await this.#terminals.terminate(String(command.terminalId));
          this.#journalEnd(owner, undefined);
          return this.#view(owner);
      }
    } catch {
      return refused("unavailable", "This terminal is no longer running.");
    }
  }

  /** Stops every shell; each ends as stopped. */
  async close(): Promise<void> {
    for (const owner of this.#owners.values()) owner.ending ??= "stopped";
    await this.#terminals.closeAll().catch(() => undefined);
    for (const owner of this.#owners.values()) this.#journalEnd(owner, undefined);
  }

  async #start(
    windowId: WindowId,
    command: Extract<SshRemoteTerminalCommand, { readonly kind: "start" }>,
  ): Promise<ProjectTerminalResult> {
    const key = String(command.terminalId);
    if (this.#owners.has(key) || this.#opened.has(key)) {
      return refused("unavailable", "This terminal id is already in use.");
    }
    const folder = this.#options.projects.folder(command.projectId, command.worktreeId);
    if (folder.status !== "ok") {
      return refused("unavailable", "This Project or worktree is not on this host.");
    }
    const { project, root, worktree } = folder.value;
    const shell = new RemoteShell();
    const opening = await this.#options.connections.openTerminal(
      project.targetId,
      TERMINAL_ADMISSION,
      {
        kind: "open-terminal",
        root,
        posture: TERMINAL_POSTURE,
        network: "none",
        columns: command.columns,
        rows: command.rows,
      },
      shell.listener,
    );
    if (opening.status === "refused") {
      return refused("unavailable", describeSshAdmissionRefusal(opening.decision));
    }
    if (opening.status === "unavailable") {
      return refused("unavailable", "The target's session ended. Connect it again and retry.");
    }
    if (opening.status === "replied") {
      return refused(
        "unavailable",
        opening.reply.reason === "root-moved" || opening.reply.reason === "root-unavailable"
          ? "This Project's folder on the target moved or is gone."
          : "The terminal could not open on the target.",
      );
    }
    const owner: Owner = {
      terminalId: command.terminalId,
      windowId,
      projectId: project.id,
      ending: undefined,
      journaled: false,
      stopObserving: undefined,
    };
    const recorded = this.#options.store.recordTerminalStarted({
      terminalId: command.terminalId,
      projectId: project.id,
      ...(worktree === undefined ? {} : { worktreeId: worktree.id }),
      windowId,
      targetId: project.targetId,
      connectionId: opening.session.connectionId,
      posture: TERMINAL_POSTURE,
    });
    if (recorded !== "recorded") {
      // A shell nobody can find in the journal is a shell nobody can account
      // for, so it does not keep running.
      opening.terminal.close();
      return refused("unavailable", "The terminal could not be recorded, so it was not started.");
    }
    this.#opened.set(key, shell.attach(opening.terminal));
    try {
      await this.#terminals.launch({
        terminalId: key,
        // The shell already runs on the target; these name nothing here.
        shell: "/bin/sh",
        cwd: root,
        stateScope: key,
        columns: command.columns,
        rows: command.rows,
        credentialReferences: [],
        executionPolicy: TERMINAL_POSTURE,
      });
    } catch {
      this.#opened.delete(key);
      opening.terminal.close();
      owner.ending = "stopped";
      this.#journalEnd(owner, undefined);
      return refused("unavailable", "The terminal could not start.");
    }
    this.#owners.set(key, owner);
    owner.stopObserving = this.#terminals.observe(key, (emission) => {
      if (emission.snapshot.status === "running") return;
      owner.ending ??= shell.lost ? "target-disconnected" : "exited";
      this.#journalEnd(owner, emission.snapshot.exitCode);
    });
    // The shell died with the session's executor and has no exit of its own
    // to report: the record keeps it as interrupted.
    opening.session.onEnd(() => {
      owner.ending ??= "target-disconnected";
      void this.#terminals.terminate(key).catch(() => undefined);
    });
    return this.#view(owner, 0);
  }

  #journalEnd(owner: Owner, exitCode: number | undefined): void {
    if (owner.journaled) return;
    owner.journaled = true;
    owner.stopObserving?.();
    this.#options.store.recordTerminalEnded({
      terminalId: owner.terminalId,
      reason: owner.ending ?? "exited",
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }

  #view(owner: Owner, afterCharacters?: number): ProjectTerminalResult {
    const read = this.#terminals.readSince(String(owner.terminalId), afterCharacters ?? 0);
    const { snapshot } = read;
    return decodeProjectTerminalResult({
      kind: "project-terminal",
      terminal: {
        projectId: owner.projectId,
        terminalId: owner.terminalId,
        state: snapshot.status,
        ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
        posture: TERMINAL_POSTURE,
      },
      ...(afterCharacters === undefined
        ? {}
        : { output: { text: read.text, replace: read.replace, characters: read.characters } }),
    });
  }
}

/**
 * One remote shell as the terminal record drives a local one: its output
 * decoded as text, its exit, and a close that waits for the shell to end.
 * Output that arrives before the record listens is held for it.
 */
class RemoteShell {
  readonly #decoder = new TextDecoder();
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  readonly #held: string[] = [];
  #exit: { exitCode: number } | undefined;
  #ended = false;
  #lost = false;
  #whenEnded: Array<() => void> = [];

  get lost(): boolean {
    return this.#lost;
  }

  readonly listener: ExecutorTerminalListener = {
    output: (bytes) => this.#publish(this.#decoder.decode(bytes, { stream: true })),
    end: (ending) => {
      if (this.#ended) return;
      this.#ended = true;
      this.#lost = ending.kind === "lost";
      this.#publish(this.#decoder.decode());
      // A shell lost with its session has no exit status of its own; the
      // record keeps it as interrupted rather than inventing one.
      if (ending.kind === "exited") {
        this.#exit = { exitCode: ending.exitCode ?? 1 };
        for (const listener of this.#exitListeners) listener(this.#exit);
      }
      for (const resolve of this.#whenEnded.splice(0)) resolve();
    },
  };

  attach(terminal: ExecutorTerminal): TerminalProcessHandle {
    return {
      write: (data) => terminal.write(data),
      resize: (columns, rows) => terminal.resize(columns, rows),
      onData: (listener) => {
        this.#dataListeners.add(listener);
        const held = this.#held.splice(0).join("");
        if (held !== "") listener(held);
        return () => this.#dataListeners.delete(listener);
      },
      onExit: (listener) => {
        this.#exitListeners.add(listener);
        const exit = this.#exit;
        if (exit !== undefined) queueMicrotask(() => listener(exit));
        return () => this.#exitListeners.delete(listener);
      },
      // The executor holds the shell while this host has not taken its
      // output; the record takes each chunk at once.
      pause: () => undefined,
      resume: () => undefined,
      close: async () => {
        if (this.#ended) return;
        terminal.close();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
          this.#whenEnded.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
  }

  #publish(text: string): void {
    if (text === "") return;
    if (this.#dataListeners.size === 0) {
      this.#held.push(text);
      return;
    }
    for (const listener of this.#dataListeners) listener(text);
  }
}

function refused(reason: ProjectTerminalRefusalReason, message: string): ProjectTerminalResult {
  return { kind: "project-terminal-refused", reason, message };
}
