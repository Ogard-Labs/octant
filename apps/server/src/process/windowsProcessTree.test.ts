import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopWindowsProcessTree, windowsSystemProgram } from "./windowsProcessTree";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Windows process-tree stop", () => {
  it("names system programs by absolute path under the Windows folder, never through PATH", () => {
    expect(windowsSystemProgram("taskkill.exe", { SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    );
    expect(windowsSystemProgram("cmd.exe", {})).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("refuses a pid that cannot name a process before running anything", async () => {
    await expect(stopWindowsProcessTree(0)).resolves.toBe("failed");
    await expect(stopWindowsProcessTree(-12)).resolves.toBe("failed");
  });

  it.runIf(process.platform === "win32")(
    "ends a shell and the program it started, which a stop of the root alone left running",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "octant-tree-stop-"));
      directories.push(directory);
      const childPidFile = join(directory, "child.pid");
      const root = spawn(
        windowsSystemProgram("WindowsPowerShell\\v1.0\\powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$child = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; Set-Content -LiteralPath '${childPidFile}' -Value $child.Id; Start-Sleep -Seconds 300`,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      const rootPid = root.pid;
      if (rootPid === undefined) throw new Error("The fixture shell did not start.");
      let childPid = 0;
      await vi.waitFor(
        () => {
          childPid = Number(readFileSync(childPidFile, "utf8").trim());
          expect(childPid).toBeGreaterThan(0);
        },
        { timeout: 20_000 },
      );
      expect(running(childPid)).toBe(true);

      await expect(stopWindowsProcessTree(rootPid)).resolves.toBe("stopped");

      await vi.waitFor(
        () => {
          expect(running(rootPid)).toBe(false);
          expect(running(childPid)).toBe(false);
        },
        { timeout: 10_000 },
      );
      await expect(stopWindowsProcessTree(rootPid)).resolves.toBe("absent");
    },
    60_000,
  );
});
