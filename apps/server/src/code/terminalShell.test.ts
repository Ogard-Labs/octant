import { describe, expect, it } from "vitest";
import {
  defaultTerminalShell,
  terminalCompletion,
  terminalShellFor,
  windowsShellArguments,
} from "./terminalShell";

describe("defaultTerminalShell", () => {
  it("keeps zsh where the host has it", () => {
    expect(defaultTerminalShell(() => true)).toBe("/bin/zsh");
  });

  it("opens bash on a Linux host that has no zsh", () => {
    expect(defaultTerminalShell((path) => path !== "/bin/zsh")).toBe("/bin/bash");
  });

  it("falls back to the POSIX shell when neither zsh nor bash is installed", () => {
    expect(defaultTerminalShell((path) => path === "/bin/sh")).toBe("/bin/sh");
  });
});

describe("the shell a Windows terminal opens", () => {
  const environment = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" };

  it("opens Windows PowerShell when Settings names no shell, and the named shell otherwise", () => {
    expect(terminalShellFor({ platform: "win32", windowsShell: undefined, environment })).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(terminalShellFor({ platform: "win32", windowsShell: "pwsh", environment })).toBe(
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    );
    expect(terminalShellFor({ platform: "win32", windowsShell: "cmd", environment })).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
  });

  it("keeps the login shell on macOS and Linux whatever the Windows setting says", () => {
    expect(terminalShellFor({ platform: "linux", windowsShell: "cmd" })).toMatch(/^\/bin\//);
  });

  it("opens each Windows shell with its own arguments and refuses one it does not know", () => {
    const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(windowsShellArguments(powershell, undefined)).toEqual(["-NoLogo"]);
    expect(windowsShellArguments(powershell, "npm test")).toEqual([
      "-NoLogo",
      "-Command",
      "npm test",
    ]);
    expect(windowsShellArguments("C:\\Windows\\System32\\cmd.exe", "dir")).toEqual([
      "/D",
      "/S",
      "/C",
      "dir",
    ]);
    expect(
      windowsShellArguments("C:\\Program Files\\Git\\bin\\bash.exe", undefined),
    ).toBeUndefined();
  });
});

describe("how a terminal command says it finished", () => {
  const marker = "oo0123456789abcdef";
  // What each shell prints once the marker line runs, after echoing the typed line.
  const cases = [
    {
      shell: "/bin/zsh",
      printed: (exit: number) => `\u001b]777;octant=${marker};exit=${exit}\u0007`,
    },
    {
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      printed: (exit: number) => `\u001b]777;octant=${marker};exit=${exit}\u0007`,
    },
    {
      shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      printed: (exit: number) => `\u001b]777;octant=${marker};exit=${exit}\u0007`,
    },
    {
      shell: "C:\\Windows\\System32\\cmd.exe",
      printed: (exit: number) => `octant=${marker};exit=${exit}\r\n`,
    },
  ];

  it.each(cases)(
    "is written in $shell's own syntax and read back with its exit code",
    ({ shell, printed }) => {
      const { command, pattern } = terminalCompletion(shell, marker);
      const windows = shell.endsWith(".exe");
      // No POSIX printf or numeric $? reaches a Windows shell, which has neither.
      expect(command.includes("printf")).toBe(!windows);
      if (shell.endsWith("powershell.exe") || shell.endsWith("pwsh.exe")) {
        expect(command).toContain("$LASTEXITCODE");
        expect(command).toContain("[char]27");
      }
      if (shell.endsWith("cmd.exe")) expect(command).toContain("%ERRORLEVEL%");
      // The shell's echo of the typed marker line is not a completion.
      expect([...command.matchAll(pattern)]).toEqual([]);
      const transcript = `${command}\r\n${printed(0)}`;
      expect([...transcript.matchAll(pattern)].map((match) => match[1])).toEqual(["0"]);
      expect([...`${command}\r\n${printed(2)}`.matchAll(pattern)].at(-1)?.[1]).toBe("2");
    },
  );
});
