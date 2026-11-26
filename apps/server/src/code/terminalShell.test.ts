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
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const cmd = "C:\\Windows\\System32\\cmd.exe";
  const codes = (transcript: string, pattern: RegExp) =>
    [...transcript.matchAll(pattern)].map((match) => match[1]);
  // PSReadLine echoes the typed line token by token, coloured, after its prompt.
  const colouredEcho = (line: string) =>
    `PS C:\\work> ${line
      .split(" ")
      .map((token) => `\u001b[93m${token}\u001b[0m`)
      .join(" ")}\r\n`;

  it("writes a POSIX shell's line with printf and reads its framed code", () => {
    const { before, command, pattern } = terminalCompletion("/bin/zsh", marker);
    expect(before).toBeUndefined();
    expect(command).toContain("printf");
    const transcript = `% ${command}\r\n\u001b]777;octant=${marker};exit=0\u0007`;
    expect(codes(transcript, pattern)).toEqual(["0"]);
  });

  it.each([powershell, pwsh])(
    "writes %s's line without printf, clearing a stale native exit code first",
    (shell) => {
      const { before, command, pattern } = terminalCompletion(shell, marker);
      expect(command).not.toContain("printf");
      // A failed cmdlet after a failed native program must not report the program's code.
      expect(before).toBe("$global:LASTEXITCODE = 0");
      expect(command.indexOf("$?")).toBeLessThan(command.indexOf("$LASTEXITCODE"));
      const echoed = colouredEcho(before ?? "") + colouredEcho(command);
      expect(codes(echoed, pattern)).toEqual([]);
      expect(
        codes(`${echoed}\u001b]777;octant=${marker};exit=1\u0007PS C:\\work> `, pattern),
      ).toEqual(["1"]);
      expect(codes(`${echoed}\u001b]777;octant=${marker};exit=-1\u0007`, pattern)).toEqual(["-1"]);
    },
  );

  it("writes Command Prompt's line as plain text ending its line, with a signed code", () => {
    const { before, command, pattern } = terminalCompletion(cmd, marker);
    expect(before).toBeUndefined();
    expect(command).toContain("%ERRORLEVEL%");
    // The console host echoes the typed line after its prompt, then prints the marker.
    const echoed = `C:\\work>${command}\r\n`;
    expect(codes(echoed, pattern)).toEqual([]);
    expect(codes(`${echoed}octant=${marker};exit=0\r\n\r\nC:\\work>`, pattern)).toEqual(["0"]);
    expect(codes(`${echoed}octant=${marker};exit=-1073741510\u001b[K\r\n`, pattern)).toEqual([
      "-1073741510",
    ]);
  });

  it.each([
    ["/bin/zsh", `\u001b]777;octant=${marker};exit=12`],
    [powershell, `\u001b]777;octant=${marker};exit=12`],
    [cmd, `octant=${marker};exit=12`],
  ])("does not read %s's marker cut off mid-read as a finished command", (shell, partial) => {
    const { pattern } = terminalCompletion(shell, marker);
    expect(codes(partial, pattern)).toEqual([]);
  });
});
