import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import type { NativeHarnessShellPort } from "../harness/nativeHarnessTools";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import type { ProcessConfinementPrepareInput } from "../process/seatbeltProfile";
import { noteIssuedSecret } from "../process/secretRedaction";
import {
  createBenchmarkCheckCommandPort,
  createBenchmarkCheckShell,
} from "./benchmarkCheckCommand";

const directories: string[] = [];
afterEach(() => {
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

describe("benchmark check command", () => {
  it("runs through the offline harness shell's confined launch, bound to the worktree with no network", async () => {
    const fake = createFakeSandboxConfinement();
    directories.push(fake.root);
    const scripts = directory();
    const worktree = directory();
    const prepared: ProcessConfinementPrepareInput[] = [];
    const child = fakeChild(4_242);
    const spawn = vi.fn(() => child);
    // Exactly the offline port the host builds for its own shell tool: network
    // none, scripts kept apart from every writable root, owned process groups.
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: fake.temporaryDirectory,
      networkEgress: "none",
      harnessShellScriptDirectory: scripts,
      confinement: {
        prepare: (input) => {
          prepared.push(input);
          return fake.confinement.prepare(input);
        },
      },
      spawn,
    });
    const commands = createBenchmarkCheckCommandPort(
      createNativeHarnessShell({ process: port, scriptDirectory: scripts }),
    );

    const running = commands.run({ command: "bun test", cwd: worktree, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.write("1 pass\n");
    child.close(0, null);

    await expect(running).resolves.toEqual({ status: "exited", exitCode: 0, output: "1 pass\n" });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      boundRoot: worktree,
      networkEgress: "none",
    });
    // The command that was spawned is the confinement's wrapper, never the shell on its own.
    const [executable, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(executable).toBe(fake.sandboxPath);
    expect(args.slice(-2)[0]).toBe("/bin/sh");
  });

  it("reports a timeout as timed out, and cuts what it keeps of the output to 4 KB", async () => {
    const shell: NativeHarnessShellPort = {
      run: async () => ({ status: "timed-out", output: "x".repeat(50_000), truncated: false }),
    };
    const outcome = await createBenchmarkCheckCommandPort(shell).run({
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
      await createBenchmarkCheckCommandPort(shell).run({
        command: "bun test",
        cwd: "/worktree",
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("starts a check command with no cloud, SSH or Google variables, and a home in the private temp folder", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "host-aws-key-id");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "host-aws-secret");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/home/me/key.json");
    const fake = createFakeSandboxConfinement();
    directories.push(fake.root);
    const scripts = directory();
    const worktree = directory();
    const child = fakeChild(4_243);
    const spawn = vi.fn(() => child);
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: fake.temporaryDirectory,
      networkEgress: "none",
      harnessShellScriptDirectory: scripts,
      confinement: fake.confinement,
      spawn,
    });
    const commands = createBenchmarkCheckCommandPort(
      createBenchmarkCheckShell({
        process: port,
        scriptDirectory: scripts,
        homeDirectory: fake.temporaryDirectory,
      }),
    );

    const running = commands.run({ command: "env", cwd: worktree, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.close(0, null);
    await running;

    const options = (
      spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    )[2];
    const names = Object.keys(options.env);
    expect(names.filter((name) => /^(AWS_|GOOGLE_|CLOUDSDK_|GCLOUD_)/.test(name))).toEqual([]);
    expect(names).not.toContain("SSH_AUTH_SOCK");
    expect(options.env.HOME).toBe(fake.temporaryDirectory);
    expect(options.env.TERM).toBe("dumb");
    expect(Object.values(options.env)).not.toContain("host-aws-secret");
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
    const outcome = await createBenchmarkCheckCommandPort(shell).run({
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
