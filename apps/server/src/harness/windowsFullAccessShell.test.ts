import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalShellFor } from "../code/terminalShell";
import { createNativeHarnessShell } from "./nativeHarnessShell";
import {
  createWindowsFullAccessShellPort,
  windowsScriptFileName,
  windowsScriptText,
} from "./windowsFullAccessShell";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(windowsShell: "powershell" | "cmd" = "powershell") {
  const root = mkdtempSync(join(tmpdir(), "octant-windows-harness-"));
  directories.push(root);
  const scriptDirectory = join(root, "scripts");
  const checkout = join(root, "checkout");
  mkdirSync(scriptDirectory);
  mkdirSync(checkout);
  const shell = () => terminalShellFor({ platform: "win32", windowsShell });
  return {
    checkout,
    harness: createNativeHarnessShell({
      process: createWindowsFullAccessShellPort({ shell, scriptDirectory }),
      scriptDirectory,
      scriptFileName: () => windowsScriptFileName(shell()),
      scriptText: (command) => windowsScriptText(shell(), command),
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

  it("ends a PowerShell script with the command's own failure and a Command Prompt script with its error level", () => {
    const powershell = windowsScriptText(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "npm test",
    );
    expect(powershell.startsWith("\uFEFF")).toBe(true);
    expect(powershell).toContain("npm test");
    expect(powershell).toContain("exit $global:LASTEXITCODE");
    expect(powershell).toContain("$ErrorActionPreference = 'Stop'");
    expect(windowsScriptText("C:\\Windows\\System32\\cmd.exe", "npm test")).toBe(
      "@echo off\r\nnpm test\r\nexit /b %errorlevel%\r\n",
    );
  });

  it.runIf(process.platform === "win32")(
    "reports a failed native program, a failed cmdlet and a failed Command Prompt command as failures",
    async () => {
      const { checkout, harness } = fixture();
      const run = (command: string) => harness.run({ command, cwd: checkout, timeoutMs: 60_000 });
      const git = await run("git.exe status");
      expect(git.status).toBe("ran");
      expect(git.status === "ran" ? git.exitCode : undefined).not.toBe(0);
      expect(await run("cmd.exe /c exit 3")).toMatchObject({ status: "ran", exitCode: 3 });
      expect(await run("Get-Item -LiteralPath does-not-exist")).toMatchObject({
        status: "ran",
        exitCode: 1,
      });
      expect(await run("cmd.exe /c exit 3; Write-Output after")).toMatchObject({
        status: "ran",
        exitCode: 3,
      });
      const cmd = fixture("cmd");
      expect(
        await cmd.harness.run({ command: "exit /b 4", cwd: cmd.checkout, timeoutMs: 60_000 }),
      ).toMatchObject({ status: "ran", exitCode: 4 });
    },
    120_000,
  );

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
