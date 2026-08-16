import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
