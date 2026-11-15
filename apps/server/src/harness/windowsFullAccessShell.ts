import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import type { HarnessShellScriptInput } from "../code/repositoryTestProcessPort";
import type { RepositoryTestProcessResult } from "../code/repositoryTestRunner";
import { WINDOWS_PROCESS_ENVIRONMENT_NAMES } from "../process/windowsEnvironment";
import { stopWindowsProcessTree, type WindowsProcessTreeStop } from "../process/windowsProcessTree";
import type { SandboxedProcessPort } from "./nativeHarnessShell";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface WindowsFullAccessShellOptions {
  /** The shell Settings › Code names, by absolute path; read as each command runs. */
  readonly shell: () => string;
  /** The harness script directory; only a script one level inside it runs. */
  readonly scriptDirectory: string;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly stopTree?: (pid: number) => Promise<WindowsProcessTreeStop>;
}

/**
 * The script file a Windows shell runs: PowerShell runs only a `.ps1` with
 * `-File`, and Command Prompt a `.cmd`. A shell other than these runs nothing.
 */
export function windowsScriptFileName(shell: string): string | undefined {
  switch (win32.basename(shell).toLowerCase()) {
    case "powershell.exe":
    case "pwsh.exe":
      return "command.ps1";
    case "cmd.exe":
      return "command.cmd";
    default:
      return undefined;
  }
}

/**
 * The script a Windows shell runs for one command, written so the command's
 * failure reaches the result. PowerShell running a `-File` script reports
 * exit 0 when a native program inside it failed, so a failed build or test
 * read as passing. The PowerShell script therefore ends with the last native
 * program's exit code when one set it, 1 when the last command failed, and 0
 * otherwise; with `$ErrorActionPreference = 'Stop'` a cmdlet's error stops
 * the command and exits 1 too. One cost: in Windows PowerShell 5.1 a native
 * program's error output that the command itself redirects (`2>&1`) counts
 * as an error, so such a command exits 1 at its first error line, a failure
 * where the program may have succeeded, never the reverse. Command Prompt
 * passes the last error level on with `exit /b`.
 */
export function windowsScriptText(shell: string, command: string): string {
  if (windowsScriptFileName(shell) === "command.cmd")
    return `@echo off\r\n${command}\r\nexit /b %errorlevel%\r\n`;
  // A byte-order mark, so Windows PowerShell 5.1 reads the script as UTF-8
  // rather than the ANSI code page, which garbles any non-ASCII command.
  return `\uFEFF${[
    "$global:LASTEXITCODE = $null",
    "$ErrorActionPreference = 'Stop'",
    "try {",
    command,
    "} catch {",
    "  [Console]::Error.WriteLine($_.ToString())",
    "  exit 1",
    "}",
    "$succeeded = $?",
    "if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE }",
    "if (-not $succeeded) { exit 1 }",
    "exit 0",
    "",
  ].join("\r\n")}`;
}

function scriptArguments(shell: string, script: string): ReadonlyArray<string> | undefined {
  switch (windowsScriptFileName(shell)) {
    case "command.ps1":
      return [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
      ];
    case "command.cmd":
      return ["/D", "/C", script];
    default:
      return undefined;
  }
}

/**
 * The harness shell tool's form at Full access on a Windows host. Full access
 * uses no sandbox, and the POSIX form runs `/bin/sh`, which Windows lacks, so
 * a command runs in the shell the person chose for terminals (Windows
 * PowerShell unless Settings › Code names another), never a guessed POSIX
 * shell. A timeout or cancellation ends the command's whole tree through the
 * Windows tree stop. It is used only at Full access with the sandbox off; the
 * levels below refuse on Windows before a command is planned.
 */
export function createWindowsFullAccessShellPort(
  options: WindowsFullAccessShellOptions,
): SandboxedProcessPort {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stopTree = options.stopTree ?? stopWindowsProcessTree;
  return {
    executeShellScript: async (input, signal) => {
      const shell = options.shell();
      const args = scriptArguments(shell, input.script);
      if (args === undefined || !(await ownScript(options.scriptDirectory, input.script, shell)))
        return unavailable();
      if (signal?.aborted) return { ...unavailable(), termination: "cancelled" };
      return await run(shell, args, input, signal, {
        maxOutputBytes,
        stopTree,
        inherited: options.inheritedEnvironment ?? process.env,
      });
    },
  };
}

/**
 * Only a script the harness wrote runs: named for the shell, in its own
 * folder one level inside the script directory.
 */
async function ownScript(scriptDirectory: string, script: string, shell: string): Promise<boolean> {
  try {
    const [root, resolved] = await Promise.all([realpath(scriptDirectory), realpath(script)]);
    return (
      win32.basename(resolved).toLowerCase() === windowsScriptFileName(shell) &&
      win32.resolve(dirname(dirname(resolved))).toLowerCase() === win32.resolve(root).toLowerCase()
    );
  } catch {
    return false;
  }
}

function inheritedWindowsEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (value !== undefined && WINDOWS_PROCESS_ENVIRONMENT_NAMES.has(name))
      environment[name] = value;
  }
  return environment;
}

function run(
  shell: string,
  args: ReadonlyArray<string>,
  input: HarnessShellScriptInput,
  signal: AbortSignal | undefined,
  options: {
    readonly maxOutputBytes: number;
    readonly stopTree: (pid: number) => Promise<WindowsProcessTreeStop>;
    readonly inherited: NodeJS.ProcessEnv;
  },
): Promise<RepositoryTestProcessResult> {
  if (input.beforeLaunch?.() === false) return Promise.resolve(unavailable());
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let ending: "timed-out" | "cancelled" | undefined;
    let cleanupUncertain = false;
    let child;
    try {
      child = spawn(shell, [...args], {
        cwd: input.cwd,
        env: { ...inheritedWindowsEnvironment(options.inherited), ...input.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(unavailable());
      return;
    }
    const capture = (into: Buffer[]) => (chunk: Buffer) => {
      const room = options.maxOutputBytes - captured;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      captured += kept.length;
      into.push(kept);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    const pid = child.pid;
    const end = (reason: "timed-out" | "cancelled") => {
      if (ending !== undefined || pid === undefined) return;
      ending = reason;
      void options.stopTree(pid).then((stopped) => {
        if (stopped === "failed") cleanupUncertain = true;
      });
    };
    const timer = setTimeout(() => end("timed-out"), input.timeoutMs);
    const abort = () => end("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const settle = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({
        termination: ending ?? "exited",
        exitCode: ending === undefined ? exitCode : null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        parserFailed: false,
        cleanupUncertain,
        ...(truncated ? { outputTruncated: true } : {}),
      });
    };
    child.once("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(unavailable());
    });
    child.once("close", (code) => settle(code));
  });
}

function unavailable(): RepositoryTestProcessResult {
  return {
    termination: "unavailable",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    parserFailed: false,
    cleanupUncertain: false,
  };
}
