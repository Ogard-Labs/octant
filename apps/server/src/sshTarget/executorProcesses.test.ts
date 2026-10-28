import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SshExecutorFrame,
  type SshExecutorStartProcessRequest,
} from "@octant/contracts/ssh-executor-protocol";
import { SshRemotePath } from "@octant/contracts/ssh-target";
import type { ProcessConfinementPort } from "../process/seatbeltProfile";
import { ExecutorEgress } from "./executorLaunches";
import { ExecutorProcesses } from "./executorProcesses";
import { checkRuntimeBinary } from "./executorRuntimeGrants";
import { ExecutorStreams } from "./executorStreams";

/**
 * The executor's placed processes with a confinement that runs the program
 * as given, so the order of a runtime's reply, output, and end, and every
 * check before a launch, can be seen frame by frame. The loopback `sshd`
 * smoke test runs real runtimes under Bubblewrap.
 */

const decodeFrame = Schema.decodeUnknownSync(SshExecutorFrame);
const remotePath = Schema.decodeUnknownSync(SshRemotePath);
const uid = process.getuid?.() ?? 0;
const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const INSTANCE = "00000000-0000-4000-8000-0000000000a2";

/**
 * Echoes each line it reads, writes a line of standard error, and exits when
 * its input ends. Without warnings, because its proxy variables make Node
 * announce its experimental proxy support on standard error.
 */
const ECHO_RUNTIME = `#!${process.execPath} --no-warnings
process.stderr.write("runtime started\\n");
process.stdin.on("data", (chunk) => process.stdout.write(chunk));
process.stdin.on("end", () => process.exit(3));
`;

/** Reports the variables it was started with on standard error, and exits when its input ends. */
const VARIABLES_RUNTIME = `#!${process.execPath} --no-warnings
const { NO_COLOR, AGENT_STATE, HOME, LANG } = process.env;
process.stderr.write(JSON.stringify({ NO_COLOR, AGENT_STATE, HOME, LANG }));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

let base: string;
let home: string;
let root: string;
let session: string;
let binary: string;
let frames: SshExecutorFrame[];

/** Runs what it is given, unconfined. */
const passThrough: ProcessConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: [...input.args] }),
};

function executable(folder: string, mode = 0o755): string {
  mkdirSync(folder, { recursive: true, mode });
  chmodSync(folder, mode);
  const path = join(folder, "agent");
  writeFileSync(path, ECHO_RUNTIME, { mode: 0o755 });
  return path;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "octant-executor-processes-"));
  chmodSync(base, 0o755);
  home = join(base, "home");
  root = join(base, "home", "app");
  session = join(base, "session");
  for (const folder of [home, join(home, ".ssh"), root, session]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  binary = executable(join(base, "bin"));
  frames = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function processes(confinement: ProcessConfinementPort = passThrough) {
  const send = (frame: SshExecutorFrame) => frames.push(decodeFrame(frame));
  const hostOpened = new ExecutorStreams({ send, opens: "odd", maxStreams: 32 });
  const egress = new ExecutorEgress(send, hostOpened, "linux");
  const placed = new ExecutorProcesses(
    send,
    {
      platform: "linux",
      uid,
      homeDirectory: home,
      stateHome: undefined,
      sessionDirectory: session,
      sessionParent: join(base, "session-parent"),
      path: process.env.PATH,
      language: undefined,
      resolveRoot: async (candidate) => ({ status: "resolved", canonical: candidate }),
      confinement,
    },
    hostOpened,
    egress,
  );
  return { placed, hostOpened };
}

function request(
  overrides: Partial<SshExecutorStartProcessRequest> = {},
): SshExecutorStartProcessRequest {
  return {
    kind: "start-process",
    root: remotePath(root),
    posture: "plan",
    network: "proxied",
    egressToken: "a".repeat(64),
    executable: remotePath(binary),
    args: [],
    accountState: [],
    home: { project: PROJECT, instance: INSTANCE },
    stream: 2,
    ...overrides,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!condition()) throw new Error("timed out");
}

describe("executor placed processes", () => {
  it("starts a runtime whose output follows its reply, echoes over its stream, and ends with its exit and last error output", async () => {
    const { placed, hostOpened } = processes();
    const reply = await placed.start(request(), 7);
    expect(reply).toEqual({ kind: "process-started", stream: 2 });
    // Nothing of the process reaches the host before the reply that names its stream.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(frames).toEqual([]);
    placed.replied(7, reply);

    const data = Buffer.from("hello\n").toString("base64");
    expect(hostOpened.receive({ type: "stream-data", stream: 2, data })).toBe("accepted");
    await waitFor(() => frames.some((frame) => frame.type === "stream-data"));
    expect(hostOpened.receive({ type: "stream-end", stream: 2 })).toBe("accepted");
    await waitFor(() => frames.some((frame) => frame.type === "process-ended"));

    const output = frames
      .flatMap((frame) => (frame.type === "stream-data" ? [frame.data] : []))
      .map((chunk) => Buffer.from(chunk, "base64").toString())
      .join("");
    expect(output).toBe("hello\n");
    const ended = frames.at(-1);
    expect(ended).toMatchObject({ type: "process-ended", stream: 2, exitCode: 3 });
    expect(ended?.type === "process-ended" && Buffer.from(ended.stderr, "base64").toString()).toBe(
      "runtime started\n",
    );
    // The end is the last word on the stream: its output, then its end.
    expect(frames.map((frame) => frame.type).filter((type) => type !== "stream-credit")).toEqual([
      "stream-data",
      "stream-end",
      "process-ended",
    ]);
    // A stop that crosses the end is harmless; one for a process never started breaks the protocol.
    expect(placed.receive({ type: "stop-process", stream: 2 })).toBe("accepted");
    expect(placed.receive({ type: "stop-process", stream: 4 })).toBe("violated");
  });

  it("stops a runtime's process group on request, and kills every runtime when the session goes", async () => {
    const { placed } = processes();
    const first = await placed.start(request(), 1);
    placed.replied(1, first);
    expect(placed.receive({ type: "stop-process", stream: 2 })).toBe("accepted");
    await waitFor(() => frames.some((frame) => frame.type === "process-ended"));
    expect(frames.at(-1)).toMatchObject({ type: "process-ended", stream: 2, signal: "SIGTERM" });

    const second = await placed.start(request({ stream: 4 }), 2);
    placed.replied(2, second);
    frames.length = 0;
    placed.abandon();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The session is gone, so nothing is said about it.
    expect(frames).toEqual([]);
  });

  it("runs at most four runtimes, and refuses a fifth as busy", async () => {
    const { placed } = processes();
    for (const [index, stream] of [2, 4, 6, 8].entries()) {
      const started = await placed.start(request({ stream }), index + 1);
      expect(started).toEqual({ kind: "process-started", stream });
      placed.replied(index + 1, started);
    }
    expect(await placed.start(request({ stream: 10 }), 5)).toEqual({
      kind: "process-refused",
      reason: "busy",
    });
    placed.abandon();
  });

  it("refuses a binary inside the root, in a folder others can write, or that is not executable", async () => {
    const { placed } = processes();
    const inside = executable(join(root, "tools"));
    expect(await placed.start(request({ executable: remotePath(inside) }), 1)).toEqual({
      kind: "process-refused",
      reason: "runtime-binary-not-confinable",
    });
    const open = executable(join(base, "open-bin"), 0o777);
    expect(await placed.start(request({ executable: remotePath(open), stream: 4 }), 2)).toEqual({
      kind: "process-refused",
      reason: "runtime-binary-not-confinable",
    });
    const plain = join(base, "bin", "plain");
    writeFileSync(plain, "not a program", { mode: 0o644 });
    expect(await placed.start(request({ executable: remotePath(plain), stream: 6 }), 3)).toEqual({
      kind: "process-refused",
      reason: "runtime-binary-not-confinable",
    });
    expect(frames).toEqual([]);
  });

  it("refuses a runtime home that is a link, or that others can enter", async () => {
    const { placed } = processes();
    const homes = join(home, ".local", "state", "octant-runtime-homes");
    mkdirSync(join(homes, PROJECT), { recursive: true, mode: 0o700 });
    mkdirSync(join(base, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(base, "elsewhere"), join(homes, PROJECT, INSTANCE));
    expect(await placed.start(request(), 1)).toEqual({
      kind: "process-refused",
      reason: "runtime-home-not-confinable",
    });
    const other = "00000000-0000-4000-8000-0000000000a3";
    mkdirSync(join(homes, PROJECT, other), { mode: 0o755 });
    chmodSync(join(homes, PROJECT, other), 0o755);
    expect(
      await placed.start(request({ home: { project: PROJECT, instance: other }, stream: 4 }), 2),
    ).toEqual({ kind: "process-refused", reason: "runtime-home-not-confinable" });
  });

  it("never grants the home beside a binary folder in it, even when the home is reached through a link", () => {
    // No ~/.ssh and no runtime homes yet, as on a first launch: only the
    // home itself says the binary's parent must not be granted.
    const realHome = join(base, "real-home");
    mkdirSync(realHome, { mode: 0o700 });
    const linkedHome = join(base, "linked-home");
    symlinkSync(realHome, linkedHome);
    const agent = executable(join(realHome, "agent-bin"));
    const checked = checkRuntimeBinary(
      { uid, homeDirectory: linkedHome, stateHome: undefined, sessionParent: undefined },
      remotePath(root),
      agent,
    );
    expect(checked).toEqual({
      status: "granted",
      value: {
        path: realpathSync(agent),
        readFolders: [realpathSync(join(realHome, "agent-bin"))],
      },
    });
  });

  it("grants account state only under the home, never the keys, the root, or a missing path", async () => {
    const { placed } = processes();
    mkdirSync(join(home, ".agent"), { mode: 0o700 });
    const started = await placed.start(
      request({
        accountState: [{ path: ".agent", access: "read-only", variable: "AGENT_STATE" }],
      }),
      1,
    );
    expect(started).toEqual({ kind: "process-started", stream: 2 });
    placed.abandon();
    const { placed: next } = processes();
    for (const [index, path] of [".ssh", "app", "app/src", ".missing"].entries()) {
      expect(
        await next.start(
          request({ accountState: [{ path, access: "read-only" }], stream: 4 + index * 2 }),
          index + 1,
        ),
      ).toEqual({ kind: "process-refused", reason: "account-state-not-confinable" });
    }
  });

  it("sets a runtime's fixed variables beside its own, and covers the denied root entries that exist when it starts", async () => {
    const prepared: Array<Parameters<ProcessConfinementPort["prepare"]>[0]> = [];
    const recording: ProcessConfinementPort = {
      prepare: (input) => {
        prepared.push(input);
        return passThrough.prepare(input);
      },
    };
    const { placed, hostOpened } = processes(recording);
    mkdirSync(join(home, ".agent"), { mode: 0o700 });
    mkdirSync(join(root, ".github", "hooks"), { recursive: true });
    writeFileSync(join(root, ".mcp.json"), "{}");
    writeFileSync(join(base, "bin", "agent"), VARIABLES_RUNTIME, { mode: 0o755 });
    const started = await placed.start(
      request({
        accountState: [{ path: ".agent", access: "read-write", variable: "AGENT_STATE" }],
        // LANG is one the executor sets itself, so the runtime keeps the target's.
        fixedVariables: [
          { name: "NO_COLOR", value: "1" },
          { name: "LANG", value: "fr_FR.UTF-8" },
        ],
        deniedRootEntries: [".mcp.json", ".github/hooks", ".agent/skills"],
      }),
      1,
    );
    expect(started).toEqual({ kind: "process-started", stream: 2 });
    placed.replied(1, started);
    expect(hostOpened.receive({ type: "stream-end", stream: 2 })).toBe("accepted");
    await waitFor(() => frames.some((frame) => frame.type === "process-ended"));
    const ended = frames.find((frame) => frame.type === "process-ended");
    const reported: unknown = JSON.parse(
      ended?.type === "process-ended" ? Buffer.from(ended.stderr, "base64").toString() : "{}",
    );
    expect(reported).toEqual({
      NO_COLOR: "1",
      AGENT_STATE: realpathSync(join(home, ".agent")),
      HOME: expect.stringContaining("octant-runtime-homes"),
      LANG: "C.UTF-8",
    });
    // A missing entry holds nothing to load at start, and covering it would
    // make it in the root, as a local launch on Linux skips it too.
    const covered = [join(root, ".mcp.json"), join(root, ".github", "hooks")];
    expect(prepared[0]?.additionalDenyReadPaths).toEqual(covered);
    expect(prepared[0]?.additionalDenyWritePaths).toEqual(covered);

    // A fixed variable may not take the name an account-state path's variable has.
    const { placed: next } = processes(recording);
    expect(
      await next.start(
        request({
          accountState: [{ path: ".agent", access: "read-write", variable: "AGENT_STATE" }],
          fixedVariables: [{ name: "AGENT_STATE", value: "elsewhere" }],
          stream: 4,
        }),
        2,
      ),
    ).toEqual({ kind: "process-refused", reason: "account-state-not-confinable" });
  });
});
