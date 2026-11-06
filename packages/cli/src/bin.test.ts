import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { hasInvalidLifecyclePositionals, parseArgs } from "./bin";

describe("server lifecycle CLI positionals", () => {
  it("rejects an extra lifecycle positional before dispatch", () => {
    const args = parseArgs(["server", "disable", "typo"]);

    expect(args).toBeDefined();
    expect(hasInvalidLifecyclePositionals(args!.command, args!.positional)).toBe(true);
  });

  it("accepts exactly one lifecycle positional", () => {
    const args = parseArgs(["server", "disable"]);

    expect(args).toBeDefined();
    expect(hasInvalidLifecyclePositionals(args!.command, args!.positional)).toBe(false);
  });
});

describe("server lifecycle CLI output", () => {
  it("prints a bounded human status report", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-cli-status-"));
    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            "bun",
            [new URL("./bin.ts", import.meta.url).pathname, "server", "status"],
            { env: { ...process.env, OCTANT_DATA_DIR: dataDirectory } },
            (_error, stdout, stderr) => resolve({ stdout, stderr }),
          );
        },
      );

      expect(stdout).toContain("Octant server service:");
      expect(stderr).toBe("");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});

/** Every file below a folder, relative to it; folders alone do not count. */
async function filesUnder(folder: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .sort();
}

function runNightly(
  args: ReadonlyArray<string>,
  home: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.OCTANT_DATA_DIR;
  delete env.OCTANT_SERVER_PORT;
  delete env.OCTANT_DESKTOP_BRIDGE_SECRET;
  return new Promise((resolve) => {
    execFile(
      "bun",
      [new URL("./nightly/bin.ts", import.meta.url).pathname, ...args],
      { env },
      (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr }),
    );
  });
}

describe("octant-nightly", () => {
  it("names itself from Nightly's identity record and lists only commands that attach", async () => {
    const home = await mkdtemp(join(tmpdir(), "octant-nightly-home-"));
    try {
      const help = await runNightly(["--help"], home);
      const version = await runNightly(["--version"], home);

      expect(help.code).toBe(0);
      expect(help.stdout.startsWith("Octant Nightly CLI\n")).toBe(true);
      expect(help.stdout).toContain("  octant-nightly agent ");
      expect(help.stdout).toContain("  octant-nightly server status");
      expect(help.stdout).not.toMatch(/^ {2}octant /m);
      expect(help.stdout).not.toContain("server start");
      expect(help.stdout).not.toContain("--dev");
      expect(version.stdout).toBe("octant-nightly development\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses when Octant's host is not running and never starts one on Octant's data", async () => {
    const home = await mkdtemp(join(tmpdir(), "octant-nightly-home-"));
    try {
      const agent = await runNightly(["agent", "--prompt", "hello", "--plain"], home);
      const start = await runNightly(["server", "start"], home);

      expect(agent.code).toBe(1);
      expect(agent.stderr).toBe(
        "Octant is not running on this host. Open Octant, or start its host with `octant server start`; octant-nightly never starts a host on Octant's data.\n",
      );
      expect(start.code).toBe(1);
      expect(start.stderr).toContain(
        "octant-nightly never starts, stops, installs or upgrades a host.",
      );
      // No host wrote anything: no receipt, secret, journal or service file.
      expect(await filesUnder(join(home, "Library", "Application Support"))).toEqual([]);
      expect(await filesUnder(join(home, "Library", "LaunchAgents"))).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "names Nightly's test host when the Data choice is test data and that host is not running",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "octant-nightly-home-"));
      try {
        const storage = join(home, "Library", "Application Support", "Octant Nightly");
        await mkdir(storage, { recursive: true });
        await writeFile(join(storage, "data-choice.json"), '{"data":"test-data"}\n');

        const project = await runNightly(["project", "add", home], home);

        expect(project.code).toBe(1);
        expect(project.stderr).toBe(
          "Octant Nightly's test host is not running. Open Octant Nightly with Data set to Separate test data to start it; octant-nightly never starts a host.\n",
        );
        expect(await filesUnder(storage)).toEqual(["data-choice.json"]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
