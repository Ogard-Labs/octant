import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWS_SANDBOX_MISSING_REASON } from "@octant/domain/guardrail-policy";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { ProcessConfinementError } from "../process/seatbeltProfile";
import { TerminalProcessPort } from "./terminalProcessPort";
import { terminalShellFor } from "./terminalShell";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * The shells and consoles still running when a real Windows check fails, so
 * the job log shows what survived a close.
 */
function logSurvivingShells(): void {
  onTestFailed(() => {
    try {
      const listing = execFileSync(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
        ["/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true },
      );
      console.log(
        listing
          .split(/\r?\n/)
          .filter((line) => /powershell|pwsh|conhost|openconsole|cmd\.exe/i.test(line))
          .join("\n"),
      );
    } catch (error) {
      console.log(`tasklist failed: ${String(error)}`);
    }
  });
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function fakePty() {
  const exits: Array<(event: { exitCode: number }) => void> = [];
  return {
    pid: 4321,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: { exitCode: number }) => void) => {
      exits.push(listener);
      return { dispose: vi.fn() };
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    exit: () => {
      for (const listener of exits) listener({ exitCode: 0 });
    },
  };
}

function confinementThatMustNotRun() {
  return {
    prepare: () => {
      throw new Error("A Windows terminal is never prepared through the confinement port.");
    },
  };
}

describe("a Code terminal on a Windows host", () => {
  it("refuses below Full access, naming the missing sandbox, before any shell starts", () => {
    const spawn = vi.fn(() => fakePty());
    const port = new TerminalProcessPort({
      platform: "win32",
      spawn,
      confinement: confinementThatMustNotRun(),
    });
    for (const executionPolicy of ["approval-gated", "auto-accept-edits", undefined] as const) {
      expect(() =>
        port.start({
          shell: POWERSHELL,
          cwd: "C:\\fixture\\project",
          stateScope: "repository",
          environment: {},
          columns: 80,
          rows: 24,
          ...(executionPolicy === undefined ? {} : { executionPolicy }),
        }),
      ).toThrow(new ProcessConfinementError("incompatible", WINDOWS_SANDBOX_MISSING_REASON));
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("opens the named PowerShell at Full access in the folder and ends its whole tree on close", async () => {
    const pty = fakePty();
    const spawn = vi.fn(() => pty);
    let shellRunning = true;
    const stopWindowsTree = vi.fn(async () => {
      shellRunning = false;
      return "stopped" as const;
    });
    const port = new TerminalProcessPort({
      platform: "win32",
      spawn,
      stopWindowsTree,
      processGroupExists: () => shellRunning,
      processIdentity: async () => "fixture",
      confinement: confinementThatMustNotRun(),
    });
    const handle = port.start({
      shell: POWERSHELL,
      command: "npm test",
      cwd: "C:\\fixture\\project",
      stateScope: "repository",
      environment: { SYSTEMROOT: "C:\\Windows", PATH: "C:\\Windows\\System32" },
      columns: 80,
      rows: 24,
      executionPolicy: "full-access",
    });
    expect(spawn).toHaveBeenCalledWith(
      POWERSHELL,
      ["-NoLogo", "-Command", "npm test"],
      expect.objectContaining({
        cwd: "C:\\fixture\\project",
        env: { SYSTEMROOT: "C:\\Windows", PATH: "C:\\Windows\\System32" },
      }),
    );
    await handle.close();
    expect(stopWindowsTree).toHaveBeenCalledWith(pty.pid);
  });

  it("closes a Windows terminal whose shell already exited without waiting for an exit that already happened", async () => {
    const pty = fakePty();
    const stopWindowsTree = vi.fn(async () => "stopped" as const);
    const port = new TerminalProcessPort({
      platform: "win32",
      spawn: () => pty,
      stopWindowsTree,
      gracefulTimeoutMs: 60_000,
      processIdentity: async () => "fixture",
      confinement: confinementThatMustNotRun(),
    });
    const handle = port.start({
      shell: POWERSHELL,
      command: "exit 3",
      cwd: "C:\\fixture\\project",
      stateScope: "repository",
      environment: {},
      columns: 80,
      rows: 24,
      executionPolicy: "full-access",
    });
    pty.exit();
    await handle.close();
    expect(stopWindowsTree).not.toHaveBeenCalled();
  });

  it("refuses a shell other than PowerShell or Command Prompt rather than handing it POSIX arguments", () => {
    const port = new TerminalProcessPort({
      platform: "win32",
      spawn: () => fakePty(),
      confinement: confinementThatMustNotRun(),
    });
    expect(() =>
      port.start({
        shell: "C:\\Program Files\\Git\\bin\\bash.exe",
        cwd: "C:\\fixture\\project",
        stateScope: "repository",
        environment: {},
        columns: 80,
        rows: 24,
        executionPolicy: "full-access",
      }),
    ).toThrow(ProcessConfinementError);
  });

  it.runIf(process.platform === "win32")(
    "runs a PowerShell command at Full access that writes a file in the folder and exits",
    async () => {
      logSurvivingShells();
      const directory = mkdtempSync(join(tmpdir(), "octant-windows-terminal-"));
      directories.push(directory);
      const handle = new TerminalProcessPort({
        receiptDirectory: join(directory, "receipts"),
      }).start({
        shell: terminalShellFor({ platform: "win32", windowsShell: undefined }),
        command: "Set-Content -LiteralPath written.txt -Value 'written by the terminal'; exit 3",
        cwd: directory,
        stateScope: "windows-terminal",
        environment: {
          SYSTEMROOT: process.env.SystemRoot ?? "C:\\Windows",
          PATH: process.env.PATH ?? "",
          USERPROFILE: process.env.USERPROFILE ?? directory,
        },
        columns: 80,
        rows: 24,
        executionPolicy: "full-access",
      });
      let exitCode: number | undefined;
      handle.onExit((event) => {
        exitCode = event.exitCode;
      });
      try {
        await handle.receiptReady;
        // ConPTY reports the exit late (about 25 seconds on windows-2025).
        await vi.waitFor(() => expect(exitCode).toBe(3), { timeout: 60_000 });
        expect(existsSync(join(directory, "written.txt"))).toBe(true);
        expect(readFileSync(join(directory, "written.txt"), "utf8")).toContain(
          "written by the terminal",
        );
      } finally {
        await handle.close();
      }
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "ends a live interactive PowerShell and reports its exit when the terminal closes",
    async () => {
      logSurvivingShells();
      const directory = mkdtempSync(join(tmpdir(), "octant-windows-terminal-"));
      directories.push(directory);
      const handle = new TerminalProcessPort({
        receiptDirectory: join(directory, "receipts"),
      }).start({
        shell: terminalShellFor({ platform: "win32", windowsShell: undefined }),
        cwd: directory,
        stateScope: "windows-terminal-live",
        environment: {
          SYSTEMROOT: process.env.SystemRoot ?? "C:\\Windows",
          PATH: process.env.PATH ?? "",
        },
        columns: 80,
        rows: 24,
        executionPolicy: "full-access",
      });
      let exited = false;
      handle.onExit(() => {
        exited = true;
      });
      await handle.receiptReady;
      expect(exited).toBe(false);
      await handle.close();
      // ConPTY reports the exit well after the process is gone (about 25
      // seconds on windows-2025); close itself has already confirmed it by pid.
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 60_000 });
    },
    90_000,
  );
});
