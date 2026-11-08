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
import { createBenchmarkCheckCommandPort } from "./benchmarkCheckCommand";

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
});
