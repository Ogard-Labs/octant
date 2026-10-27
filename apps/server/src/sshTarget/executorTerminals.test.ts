import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SSH_EXECUTOR_MAX_TERMINALS,
  SSH_EXECUTOR_TERMINAL_WINDOW_BYTES,
  type SshExecutorFrame,
  type SshExecutorOpenTerminalRequest,
} from "@octant/contracts/ssh-executor-protocol";
import { SshRemotePath } from "@octant/contracts/ssh-target";
import { Schema } from "effect";
import type { PtyProcess } from "../code/terminalProcessPort";
import type { ProcessConfinementPrepareInput } from "../process/seatbeltProfile";
import { ExecutorTerminals } from "./executorTerminals";

/**
 * The executor's terminals against a stand-in pseudo-terminal, so the flow
 * control and the order of a shell's last output and its exit can be seen
 * frame by frame. The loopback `sshd` smoke test runs a real confined shell.
 */

class FakePty implements PtyProcess {
  readonly pid = 2_147_000_000;
  readonly written: string[] = [];
  paused = false;
  #data: ((data: string) => void) | undefined;
  #exit: ((event: { exitCode: number }) => void) | undefined;
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  onData(listener: (data: string) => void) {
    this.#data = listener;
    return { dispose: () => undefined };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.#exit = listener;
    return { dispose: () => undefined };
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  print(text: string): void {
    this.#data?.(text);
  }
  exit(exitCode: number): void {
    this.#exit?.({ exitCode });
  }
}

let session: string;
const root = Schema.decodeUnknownSync(SshRemotePath)("/srv/app");

beforeEach(() => {
  session = mkdtempSync(join(tmpdir(), "octant-executor-terminals-"));
});

afterEach(() => {
  rmSync(session, { recursive: true, force: true });
});

function terminals() {
  const frames: SshExecutorFrame[] = [];
  const ptys: FakePty[] = [];
  const launches: ProcessConfinementPrepareInput[] = [];
  const service = new ExecutorTerminals((frame) => frames.push(frame), {
    platform: "linux",
    sessionDirectory: session,
    shell: "/bin/sh",
    path: "/usr/bin:/bin",
    language: "C.UTF-8",
    confinement: {
      prepare: (input) => {
        launches.push(input);
        return { command: "/usr/bin/bwrap", args: ["--", input.executable, ...input.args] };
      },
    },
    loadSpawn: async () => () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  return { service, frames, ptys, launches };
}

const open = (terminal: number): SshExecutorOpenTerminalRequest => ({
  kind: "open-terminal",
  root,
  terminal,
  posture: "approval-gated",
  network: "none",
  columns: 80,
  rows: 24,
});

const outputBytes = (frames: ReadonlyArray<SshExecutorFrame>, terminal: number) =>
  frames
    .filter((frame) => frame.type === "terminal-output" && frame.terminal === terminal)
    .reduce(
      (total, frame) =>
        total + (frame.type === "terminal-output" ? Buffer.from(frame.data, "base64").length : 0),
      0,
    );

describe("executor terminals", () => {
  it("opens a shell with its posture's grants, offline, its home a folder of the session's", async () => {
    const { service, launches } = terminals();
    expect(await service.open(root, open(1))).toEqual({ kind: "terminal-opened" });
    expect(launches[0]).toMatchObject({
      executable: "/bin/sh",
      args: ["-l"],
      boundRoot: root,
      networkEgress: "none",
      writeBoundRoot: true,
      allowProcessExec: true,
      terminal: { shellStateDirectory: join(session, "terminals", "1") },
    });
  });

  it("sends no more output than the host granted, holds the shell meanwhile, and says it exited only after its last output", async () => {
    const { service, frames, ptys } = terminals();
    await service.open(root, open(1));
    const pty = ptys[0];
    if (pty === undefined) throw new Error("no shell");
    pty.print("x".repeat(SSH_EXECUTOR_TERMINAL_WINDOW_BYTES + 10_000));
    pty.exit(3);
    expect(outputBytes(frames, 1)).toBe(SSH_EXECUTOR_TERMINAL_WINDOW_BYTES);
    expect(pty.paused).toBe(true);
    expect(frames.some((frame) => frame.type === "terminal-exited")).toBe(false);

    service.receive({ type: "terminal-credit", terminal: 1, bytes: 65_536 });
    expect(outputBytes(frames, 1)).toBe(SSH_EXECUTOR_TERMINAL_WINDOW_BYTES + 10_000);
    expect(frames.at(-1)).toEqual({ type: "terminal-exited", terminal: 1, exitCode: 3 });
    // A frame for a shell that ended is dropped, not an error.
    expect(service.receive({ type: "terminal-input", terminal: 1, data: "bHMK" })).toBe("accepted");
  });

  it("refuses an id that is not new and a terminal past the session's most", async () => {
    const { service } = terminals();
    for (let id = 1; id <= SSH_EXECUTOR_MAX_TERMINALS; id += 1) {
      expect(await service.open(root, open(id))).toEqual({ kind: "terminal-opened" });
    }
    expect(await service.open(root, open(SSH_EXECUTOR_MAX_TERMINALS + 1))).toEqual({
      kind: "terminal-unavailable",
    });
    expect(await service.open(root, open(2))).toEqual({ kind: "terminal-unavailable" });
  });

  it("opens nothing once the session is gone, and sends nothing for the shells it ended", async () => {
    const { service, frames, ptys } = terminals();
    await service.open(root, open(1));
    service.abandon();
    ptys[0]?.print("late");
    ptys[0]?.exit(0);
    expect(frames).toEqual([]);
    expect(await service.open(root, open(2))).toEqual({ kind: "terminal-unavailable" });
  });
});
