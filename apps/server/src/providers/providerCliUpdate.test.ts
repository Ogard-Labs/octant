import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerCliUpdateArgs, runProviderCliUpdate } from "./providerCliUpdate";

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
    expect(providerCliUpdateArgs("gemini")).toBeUndefined();
    expect(providerCliUpdateArgs("cline")).toEqual(["update"]);
    expect(providerCliUpdateArgs("copilot")).toEqual(["update"]);
    expect(providerCliUpdateArgs("opencode")).toBeUndefined();
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
          terminationGraceMs: 200,
        }),
      ).rejects.toMatchObject({
        category: "unavailable",
        message: "Provider CLI update timed out.",
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

  it("fails closed when the updater process tree cannot be confirmed gone", async () => {
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
      message:
        "Provider CLI update did not confirm that the updater process tree exited. Restart Octant before another update or session on this CLI.",
    });
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
