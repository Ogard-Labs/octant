import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { readProcessIdentity } from "../process/nodeOwnedProcessReceipt";
import { stopWindowsProcessTree, windowsSystemProgram } from "../process/windowsProcessTree";
import { terminalShellFor } from "../code/terminalShell";
import { createNativeHarnessShell } from "./nativeHarnessShell";
import type { NativeHarnessShellRun } from "./nativeHarnessTools";
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

function running_(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every shell and ping with its parent, so a failed run shows what survived and under whom. */
function windowsProcessList(): string {
  try {
    return execFileSync(
      windowsSystemProgram("WindowsPowerShell\\v1.0\\powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'powershell|pwsh|ping|cmd' } | ForEach-Object { \"$($_.ProcessId) parent=$($_.ParentProcessId) $($_.Name) $($_.CreationDate)\" }",
      ],
      { encoding: "utf8", windowsHide: true },
    );
  } catch (error) {
    return `process list failed: ${String(error)}`;
  }
}

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

  it("ends a timed-out command's call as uncertain when its tree stop fails and the command never closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "octant-windows-harness-"));
    directories.push(root);
    const folder = join(root, "scripts", "octant-harness-1");
    mkdirSync(folder, { recursive: true });
    const script = join(folder, "command.ps1");
    writeFileSync(script, "Start-Sleep -Seconds 300\n");
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const stopTree = vi.fn(async () => "failed" as const);
    const port = createWindowsFullAccessShellPort({
      shell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      scriptDirectory: join(root, "scripts"),
      stopTree,
      stopWaitMs: 50,
      spawn: (() => child) as never,
    });
    const result = await port.executeShellScript({
      script,
      cwd: root,
      environment: {},
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ termination: "timed-out", cleanupUncertain: true });
    expect(stopTree).toHaveBeenCalledWith(4242);
  });

  it("returns a short command's real result when it ended before its identity could be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "octant-windows-harness-"));
    directories.push(root);
    const folder = join(root, "scripts", "octant-harness-2");
    mkdirSync(folder, { recursive: true });
    const script = join(folder, "command.ps1");
    writeFileSync(script, "Write-Output done\n");
    // A pid no process holds: the command has already ended.
    const child = Object.assign(new EventEmitter(), {
      pid: 2_147_483_002,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    let closed: () => void = () => undefined;
    const closedOnce = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const stopTree = vi.fn(async () => "stopped" as const);
    const port = createWindowsFullAccessShellPort({
      shell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      scriptDirectory: join(root, "scripts"),
      receiptDirectory: join(root, "receipts"),
      stopTree,
      // The identity is read only after the command has closed, and finds it gone.
      processIdentity: async () => {
        await closedOnce;
        return undefined;
      },
      spawn: (() => {
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("done\n"));
          child.emit("exit", 0);
          child.emit("close", 0);
          closed();
        });
        return child;
      }) as never,
    });
    const result = await port.executeShellScript({
      script,
      cwd: root,
      environment: {},
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ termination: "exited", exitCode: 0 });
    expect(Buffer.from(result.stdout).toString("utf8")).toBe("done\n");
    expect(stopTree).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "finds and stops a long command a crashed host left running, from its receipt, and removes the receipt",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "octant-windows-harness-"));
      directories.push(root);
      const scriptDirectory = join(root, "scripts");
      const receiptDirectory = join(root, "receipts");
      const checkout = join(root, "checkout");
      mkdirSync(scriptDirectory);
      mkdirSync(checkout);
      const shell = () => terminalShellFor({ platform: "win32", windowsShell: undefined });
      const harness = createNativeHarnessShell({
        process: createWindowsFullAccessShellPort({ shell, scriptDirectory, receiptDirectory }),
        scriptDirectory,
        scriptFileName: () => windowsScriptFileName(shell()),
        scriptText: (command) => windowsScriptText(shell(), command),
      });
      const stop = new AbortController();
      const running = harness.run({
        command:
          "$child = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; Set-Content -LiteralPath child.pid -Value $child.Id; Start-Sleep -Seconds 300",
        cwd: checkout,
        timeoutMs: 280_000,
        signal: stop.signal,
      });
      let endedEarly: NativeHarnessShellRun | undefined;
      void running.then((run) => {
        endedEarly = run;
      });
      onTestFailed(() => {
        console.log(JSON.stringify({ endedEarly }));
        console.log(windowsProcessList());
      });
      try {
        // Waits for the command to start its program and keep its receipt, or
        // for the run to end, whichever comes first, so a run that ends early
        // fails here with its own result. It once waited a bare 30 seconds and
        // showed nothing of a run that had already ended. The bound sits above
        // the 60-second Windows identity read, past which the receipt fails
        // and the run ends unowned.
        await vi.waitFor(
          () => {
            if (endedEarly !== undefined) return;
            if (!existsSync(join(checkout, "child.pid")))
              throw new Error("The command has not started its program yet.");
            if (readdirSync(receiptDirectory).length !== 1)
              throw new Error("The command has no receipt yet.");
          },
          { timeout: 90_000, interval: 100 },
        );
        expect(endedEarly).toBeUndefined();
      } catch (error) {
        // A failed start still ends the command and its program, through the
        // harness's own cancellation.
        stop.abort();
        await running;
        throw error;
      }
      const childPid = Number(readFileSync(join(checkout, "child.pid"), "utf8").trim());
      const receiptName = readdirSync(receiptDirectory)[0] ?? "";
      const receipt = JSON.parse(readFileSync(join(receiptDirectory, receiptName), "utf8")) as {
        readonly pid: number;
        readonly processIdentity: string;
      };
      const evidence: Record<string, unknown> = {
        receiptPid: receipt.pid,
        receiptIdentity: receipt.processIdentity,
        identityBeforeRestart: await readProcessIdentity(receipt.pid),
        childPid,
      };
      onTestFailed(() => {
        console.log(JSON.stringify(evidence));
      });
      try {
        // The restart: a fresh port over the same receipts, as the next start builds.
        await createWindowsFullAccessShellPort({
          shell,
          scriptDirectory,
          receiptDirectory,
        }).reconcile();
        evidence.identityAfterRestart = await readProcessIdentity(receipt.pid);
        evidence.receiptsAfterRestart = readdirSync(receiptDirectory);
        await vi.waitFor(() => expect(running_(childPid)).toBe(false), { timeout: 20_000 });
        expect(running_(receipt.pid)).toBe(false);
        expect(readdirSync(receiptDirectory)).toEqual([]);
        const ended = await running;
        expect(ended.status).not.toBe("timed-out");
      } finally {
        // Whatever the outcome, nothing of the fixture outlives the test.
        await stopWindowsProcessTree(receipt.pid);
        await stopWindowsProcessTree(childPid);
      }
    },
    180_000,
  );

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
