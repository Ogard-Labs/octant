import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeProviderFailure } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  isProviderCliUpdateTerminationUnconfirmed,
  providerCliUpdateArgs,
  runProviderCliUpdate,
} from "./providerCliUpdate";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("provider-owned CLI updates", () => {
  it("only advertises commands verified for the provider binary", () => {
    expect(providerCliUpdateArgs("kimi-code")).toEqual(["upgrade"]);
    expect(providerCliUpdateArgs("devin")).toEqual(["update"]);
    expect(providerCliUpdateArgs("mistral-vibe")).toEqual(["update"]);
    expect(providerCliUpdateArgs("grok")).toEqual(["update"]);
    expect(providerCliUpdateArgs("codex")).toEqual(["update"]);
    expect(providerCliUpdateArgs("claude")).toEqual(["update"]);
    expect(providerCliUpdateArgs("opencode")).toEqual(["upgrade"]);
    expect(providerCliUpdateArgs("gemini")).toBeUndefined();
    expect(providerCliUpdateArgs("cline")).toEqual(["update"]);
    expect(providerCliUpdateArgs("copilot")).toEqual(["update"]);
    expect(providerCliUpdateArgs("goose")).toBeUndefined();
  });

  it("waits for a timed-out provider updater to terminate before rejecting", async () => {
    const started = Date.now();

    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", "process.once('SIGTERM', () => {}); setTimeout(() => {}, 10000)"],
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      diagnostic: { stage: "update", kind: "timed-out" },
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
  });

  it("terminates a SIGTERM-ignoring updater and its spawned descendant before rejecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-cli-update-tree-"));
    const pidFile = join(directory, "pids.json");
    try {
      await expect(
        runProviderCliUpdate({
          binaryPath: process.execPath,
          args: [
            "-e",
            `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.once("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.once('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);`,
          ],
          timeoutMs: 1_000,
          // Use the real cleanup grace: 200 ms can expire while the OS reaps
          // the killed descendant during the concurrent repository suite.
        }),
      ).rejects.toMatchObject({
        category: "unavailable",
        message: "Provider CLI update timed out.",
        diagnostic: { stage: "update", kind: "timed-out" },
      });

      const recorded = JSON.parse(await readFile(pidFile, "utf8")) as {
        readonly parent: number;
        readonly child: number;
      };
      expect(processExists(recorded.parent)).toBe(false);
      expect(processExists(recorded.child)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs one termination sequence when process closure races the timeout", async () => {
    const signals: NodeJS.Signals[] = [];
    let released = false;
    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 100,
        terminationGraceMs: 50,
        processGroupExists: () => !released,
        killProcessGroup: (pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") released = true;
          try {
            process.kill(pid, signal);
          } catch {
            /* The child may already be reaped. */
          }
        },
      }),
    ).rejects.toMatchObject({ diagnostic: { stage: "update", kind: "timed-out" } });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("advises a restart when a clean-exiting updater leaves a process tree that cannot be confirmed gone", async () => {
    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 5_000,
        terminationGraceMs: 20,
        processGroupExists: () => true,
        killProcessGroup: (pid, signal) => {
          try {
            process.kill(process.platform === "win32" ? pid : -pid, signal);
          } catch {
            // The real tree is still reaped so the fixture does not leak.
          }
        },
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      message:
        "Provider CLI update did not confirm that the updater process tree exited. Restart Octant before another update or session on this CLI.",
    });
  });

  it("reports a timeout as a timeout even when the killed tree's exit cannot be confirmed in time", async () => {
    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", "process.once('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        timeoutMs: 500,
        terminationGraceMs: 20,
        processGroupExists: () => true,
        killProcessGroup: (pid, signal) => {
          try {
            process.kill(process.platform === "win32" ? pid : -pid, signal);
          } catch {
            // The real tree is still reaped so the fixture does not leak.
          }
        },
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      message: "Provider CLI update timed out.",
      diagnostic: { stage: "update", kind: "timed-out" },
    });
  });

  it("holds the executable claim when a timed-out update cannot signal its process group", async () => {
    let pid = 0;
    let caught: unknown;
    try {
      await runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30_000)"],
        timeoutMs: 200,
        terminationGraceMs: 20,
        processGroupExists: (seen) => {
          pid = seen;
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
        killProcessGroup: () => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      if (pid !== 0) {
        try {
          process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
        } catch {
          // The child may already have exited.
        }
      }
    }

    expect(decodeProviderFailure(caught)).toMatchObject({
      category: "unavailable",
      message: "Provider CLI update timed out.",
      diagnostic: { stage: "update", kind: "cleanup-unconfirmed" },
    });
    expect(isProviderCliUpdateTerminationUnconfirmed(caught)).toBe(true);
  });

  it("reports unconfirmed cleanup when signaling the updater is denied", async () => {
    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 100,
        terminationGraceMs: 10,
        processGroupExists: () => true,
        killProcessGroup: () => {
          throw Object.assign(new Error("private process details"), { code: "EPERM" });
        },
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      message:
        "Provider CLI update did not confirm that the updater process tree exited. Restart Octant before another update or session on this CLI.",
      diagnostic: { stage: "cleanup", kind: "cleanup-unconfirmed" },
    });
  }, 2000);

  it("bounds captured updater output in bytes and drains the rest without growing memory", async () => {
    const result = await runProviderCliUpdate({
      binaryPath: process.execPath,
      args: [
        "-e",
        'process.stdout.write("a".repeat(40_000)); process.stderr.write("secret-token-value");',
      ],
      timeoutMs: 5_000,
    });
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(16_384);
    expect(result.output).not.toContain("secret-token-value");
    expect(result.exitCode).toBe(0);
  });

  it("returns only bounded classified stderr metadata when an updater exits unsuccessfully", async () => {
    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: [
          "-e",
          'process.stderr.write("error: unexpected argument --private-token=must-not-cross"); process.exit(23);',
        ],
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      category: "provider-failed",
      diagnostic: {
        stage: "update",
        kind: "exited",
        exitCode: 23,
        stderrContext: "Provider process rejected its configured arguments.",
      },
    });
    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", 'process.stderr.write("private-token=must-not-cross"); process.exit(24);'],
        timeoutMs: 5_000,
      }),
    ).rejects.not.toMatchObject({ message: expect.stringContaining("must-not-cross") });
  });

  it("applies a disposable updater fixture that writes a new version marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-cli-update-fixture-"));
    const binaryPath = join(directory, "provider-cli");
    const versionPath = join(directory, "version.txt");
    try {
      await writeFile(versionPath, "1.0.0\n");
      await writeFile(
        binaryPath,
        `#!/bin/sh
if [ "$1" = "--version" ]; then cat "${versionPath}"; exit 0; fi
if [ "$1" = "update" ]; then printf '1.1.0\\n' > "${versionPath}"; exit 0; fi
exit 1
`,
      );
      await chmod(binaryPath, 0o755);
      const updated = await runProviderCliUpdate({
        binaryPath,
        args: ["update"],
        timeoutMs: 5_000,
      });
      expect(updated.exitCode).toBe(0);
      expect((await readFile(versionPath, "utf8")).trim()).toBe("1.1.0");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the desktop's broker addresses and tokens from a provider's updater", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-cli-update-authority-"));
    const seen = join(directory, "seen.json");
    const names = [
      "OCTANT_SIMULATOR_DEVICE_BROKER_URL",
      "OCTANT_SIMULATOR_DEVICE_BROKER_TOKEN",
      "OCTANT_COMPUTER_USE_BROKER_TOKEN",
      "OCTANT_CREDENTIAL_BROKER_TOKEN",
      "OCTANT_DESKTOP_BRIDGE_SECRET",
    ];
    const before = names.map((name) => process.env[name]);
    try {
      for (const name of names) process.env[name] = "only-for-the-host";
      process.env.OCTANT_UPDATER_FIXTURE = "kept";
      await runProviderCliUpdate({
        binaryPath: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env))`,
        ],
        timeoutMs: 5_000,
      });

      const environment = JSON.parse(await readFile(seen, "utf8")) as Record<string, string>;
      for (const name of names) expect(environment[name]).toBeUndefined();

      // A caller that builds the environment itself usually starts from the
      // host's, so what it passes is filtered the same way.
      await runProviderCliUpdate({
        binaryPath: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env))`,
        ],
        environment: { ...process.env, OCTANT_UPDATER_EXTRA: "1" },
        timeoutMs: 5_000,
      });
      const supplied = JSON.parse(await readFile(seen, "utf8")) as Record<string, string>;
      for (const name of names) expect(supplied[name]).toBeUndefined();
      expect(supplied.OCTANT_UPDATER_EXTRA).toBe("1");
      // Everything else a provider's own tooling relies on still arrives.
      expect(environment.OCTANT_UPDATER_FIXTURE).toBe("kept");
      expect(environment.PATH).toBe(process.env.PATH);
    } finally {
      names.forEach((name, index) => {
        if (before[index] === undefined) delete process.env[name];
        else process.env[name] = before[index];
      });
      delete process.env.OCTANT_UPDATER_FIXTURE;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs the updater in the binary directory with the inherited host environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-cli-update-env-"));
    const marker = join(directory, "cwd.txt");
    try {
      const result = await runProviderCliUpdate({
        binaryPath: process.execPath,
        args: [
          "-e",
          `const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), marker: process.env.OCTANT_UPDATER_MARKER }));`,
        ],
        environment: { ...process.env, OCTANT_UPDATER_MARKER: "host-inherited" },
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
        cwd: dirname(process.execPath),
        marker: "host-inherited",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
