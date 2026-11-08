import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeHarnessShellPort } from "../harness/nativeHarnessTools";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import type { ProcessConfinementPrepareInput } from "../process/seatbeltProfile";
import { noteIssuedSecret } from "../process/secretRedaction";
import { createBenchmarkCheckCommands, createBenchmarkCheckSession } from "./benchmarkCheckCommand";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "octant-benchmark-check-")));
  directories.push(path);
  return path;
}

function fakeChild(pid: number) {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    close(code: number | null, signal: NodeJS.Signals | null) {
      child.stdout.end();
      child.stderr.end();
      events.emit("close", code, signal);
    },
  });
  return child;
}

type SpawnCall = [string, string[], { env: Record<string, string>; cwd: string }];

/** The real confined port with a recording confinement and a launcher that never starts a process. */
function rig() {
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  const prepared: ProcessConfinementPrepareInput[] = [];
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const spawn = vi.fn(() => {
    const child = fakeChild(4_242 + children.length);
    children.push(child);
    return child;
  });
  const killProcessGroup = vi.fn((group: number, signal: NodeJS.Signals) => {
    children.find((child) => child.pid === -group)?.close(null, signal);
  });
  const root = join(directory(), "checks");
  const commands = createBenchmarkCheckCommands({
    root,
    scriptDirectory: directory(),
    receiptDirectory: directory(),
    processOptions: {
      confinement: {
        prepare: (input) => {
          prepared.push(input);
          return fake.confinement.prepare(input);
        },
      },
      spawn,
      killProcessGroup,
      processGroupExists: () => false,
      // The launched children are fakes, so no process has an identity to read.
      processIdentity: async () => "fake-identity",
    },
  });
  const spawned = (index: number) => spawn.mock.calls[index] as unknown as SpawnCall;
  return { commands, prepared, spawn, spawned, children, killProcessGroup, root, fake };
}

describe("benchmark check commands", () => {
  it("run through a confined launch of their own: bound to the worktree, no network, setsid refused", async () => {
    const { commands, prepared, spawn, spawned, children, fake } = rig();
    const worktree = directory();
    const session = await commands.open();

    const running = session.run({ command: "bun test", cwd: worktree, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.stdout.write("1 pass\n");
    children[0]!.close(0, null);

    const outcome = await running;
    expect(outcome).toEqual({ status: "exited", exitCode: 0, output: "1 pass\n" });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      boundRoot: worktree,
      networkEgress: "none",
      refuseNewSession: true,
    });
    // The spawned command is the confinement's wrapper, never the shell on its own.
    expect(spawned(0)[0]).toBe(fake.sandboxPath);
    expect(spawned(0)[1].slice(-2)[0]).toBe("/bin/sh");
    await session.close();
  });

  it("starts a command with no cloud, SSH or Google variables and a home and temp folder of its own", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "host-aws-key-id");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "host-aws-secret");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/home/me/key.json");
    const { commands, spawn, spawned, children } = rig();
    const worktree = directory();
    vi.stubEnv("TMPDIR", "/private/var/host-temp/");
    const session = await commands.open();

    const running = session.run({ command: "env", cwd: worktree, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    children[0]!.close(0, null);
    await running;

    const env = spawned(0)[2].env;
    expect(
      Object.keys(env).filter((name) => /^(AWS_|GOOGLE_|CLOUDSDK_|GCLOUD_)/.test(name)),
    ).toEqual([]);
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(Object.values(env)).not.toContain("host-aws-secret");
    expect(env.TERM).toBe("dumb");
    // Home and every temporary root are the sequence's folder, not the host's.
    expect(env.HOME).toBeDefined();
    expect([env.TMPDIR, env.TEMP, env.TMP]).toEqual([env.HOME, env.HOME, env.HOME]);
    expect(env.TMPDIR).not.toContain("host-temp");
    await session.close();
  });

  it("gives each cell its own folder, shares nothing between them, and removes it after the checks", async () => {
    const { commands, root, spawn, spawned, children } = rig();
    const worktreeOne = directory();
    const worktreeTwo = directory();
    const first = await commands.open();
    const second = await commands.open();

    const one = first.run({ command: "true", cwd: worktreeOne, timeoutMs: 5_000 });
    const two = second.run({ command: "true", cwd: worktreeTwo, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    for (const child of children) child.close(0, null);
    await Promise.all([one, two]);

    const envOf = (cwd: string) =>
      [0, 1].map((index) => spawned(index)).find((call) => call[2].cwd === cwd)![2].env;
    const homeOne = envOf(worktreeOne).HOME!;
    const homeTwo = envOf(worktreeTwo).HOME!;
    expect(homeOne).not.toBe(homeTwo);
    expect(envOf(worktreeOne).TMPDIR).not.toBe(envOf(worktreeTwo).TMPDIR);
    expect(homeOne.startsWith(root)).toBe(true);
    // A file one cell's command planted is not in the other's folder.
    writeFileSync(join(homeOne, ".npmrc"), "registry=http://planted.invalid/\n");
    expect(existsSync(join(homeTwo, ".npmrc"))).toBe(false);

    await first.close();
    expect(existsSync(homeOne)).toBe(false);
    expect(existsSync(homeTwo)).toBe(true);
    await second.close();
    await second.close();
    expect(existsSync(homeTwo)).toBe(false);
  });

  it("sweeps folders a crash left behind, and nothing else", async () => {
    const { commands, root } = rig();
    const stale = await commands.open();
    const other = join(root, "not-a-check");
    mkdirSync(other, { recursive: true });
    const staleFolders = readdirSync(root).filter((name) => name.startsWith("check-"));
    expect(staleFolders).toHaveLength(1);

    await commands.sweep?.();

    expect(readdirSync(root)).toEqual(["not-a-check"]);
    await stale.close();
  });

  it("ends the command's whole process group when the check is aborted", async () => {
    const { commands, spawn, killProcessGroup } = rig();
    const session = await commands.open();
    const controller = new AbortController();

    const running = session.run({
      command: "sleep 999",
      cwd: directory(),
      timeoutMs: 600_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    controller.abort();

    await expect(running).resolves.toMatchObject({ status: "unavailable" });
    expect(killProcessGroup).toHaveBeenCalled();
    expect(killProcessGroup.mock.calls[0]?.[0]).toBe(-4_242);
    await session.close();
  });
});

describe("benchmark check session", () => {
  it("reports a timeout as timed out, and cuts what it keeps of the output to 4 KB", async () => {
    const shell: NativeHarnessShellPort = {
      run: async () => ({ status: "timed-out", output: "x".repeat(50_000), truncated: false }),
    };
    const outcome = await createBenchmarkCheckSession(shell).run({
      command: "sleep 99",
      cwd: "/worktree",
      timeoutMs: 1_000,
    });
    expect(outcome.status).toBe("timed-out");
    expect(outcome.status === "timed-out" && outcome.output.length).toBe(4_096);
  });

  it("never runs a command the sandbox refused to launch", async () => {
    const shell: NativeHarnessShellPort = {
      run: async () => ({ status: "unavailable", output: "", truncated: false }),
    };
    expect(
      await createBenchmarkCheckSession(shell).run({
        command: "bun test",
        cwd: "/worktree",
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("redacts a secret in the output before any of it is kept", async () => {
    const handedOut = ["hunter2", "a", "handed", "out", "secret"].join("-");
    const tokenShaped = `${"ghp"}_${"a".repeat(36)}`;
    noteIssuedSecret(handedOut);
    const shell: NativeHarnessShellPort = {
      run: async () => ({
        status: "ran",
        exitCode: 1,
        output: `token=${handedOut} and ${tokenShaped}`,
        truncated: false,
      }),
    };
    const outcome = await createBenchmarkCheckSession(shell).run({
      command: "bun test",
      cwd: "/worktree",
      timeoutMs: 1_000,
    });
    expect(outcome.status).toBe("exited");
    const output = outcome.status === "exited" ? outcome.output : "";
    expect(output).not.toContain(handedOut);
    expect(output).not.toContain(tokenShaped);
  });
});
