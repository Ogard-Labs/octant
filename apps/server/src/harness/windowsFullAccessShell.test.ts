import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalShellFor } from "../code/terminalShell";
import { createNativeHarnessShell } from "./nativeHarnessShell";
import { createWindowsFullAccessShellPort, windowsScriptFileName } from "./windowsFullAccessShell";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "octant-windows-harness-"));
  directories.push(root);
  const scriptDirectory = join(root, "scripts");
  const checkout = join(root, "checkout");
  mkdirSync(scriptDirectory);
  mkdirSync(checkout);
  const shell = () => terminalShellFor({ platform: "win32", windowsShell: undefined });
  return {
    checkout,
    harness: createNativeHarnessShell({
      process: createWindowsFullAccessShellPort({ shell, scriptDirectory }),
      scriptDirectory,
      scriptFileName: () => windowsScriptFileName(shell()),
    }),
  };
}

describe("the harness shell at Full access on a Windows host", () => {
  it("writes a PowerShell or Command Prompt script and runs no other shell", () => {
    expect(
      windowsScriptFileName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    ).toBe("command.ps1");
    expect(windowsScriptFileName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("command.ps1");
    expect(windowsScriptFileName("C:\\Windows\\System32\\cmd.exe")).toBe("command.cmd");
    expect(windowsScriptFileName("C:\\Program Files\\Git\\bin\\bash.exe")).toBeUndefined();
  });

  it.runIf(process.platform === "win32")(
    "runs a turn's command in Windows PowerShell that writes a file in the checkout and returns its output",
    async () => {
      const { checkout, harness } = fixture();
      const run = await harness.run({
        command:
          "Set-Content -LiteralPath written-by-turn.txt -Value 'from the harness'; Write-Output \"ran-$(40 + 2)\"",
        cwd: checkout,
        timeoutMs: 60_000,
      });
      expect(run).toMatchObject({ status: "ran", exitCode: 0 });
      expect(run.output).toContain("ran-42");
      expect(existsSync(join(checkout, "written-by-turn.txt"))).toBe(true);
      expect(readFileSync(join(checkout, "written-by-turn.txt"), "utf8")).toContain(
        "from the harness",
      );
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "ends a command and the program it started when the command times out",
    async () => {
      const { checkout, harness } = fixture();
      const run = await harness.run({
        command:
          "$child = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; Set-Content -LiteralPath child.pid -Value $child.Id; Start-Sleep -Seconds 300",
        cwd: checkout,
        timeoutMs: 8_000,
      });
      expect(run.status).toBe("timed-out");
      const childPid = Number(readFileSync(join(checkout, "child.pid"), "utf8").trim());
      expect(childPid).toBeGreaterThan(0);
      let running = true;
      for (let attempt = 0; attempt < 50 && running; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch {
          running = false;
        }
      }
      expect(running).toBe(false);
    },
    90_000,
  );
});
