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

  it.each(["/bin/zsh", powershell, pwsh, cmd])(
    "types %s's completion in the same input as the command, so a program reading its input cannot take it",
    (shell) => {
      const typed = terminalCompletion(shell, marker).wrap("npm run dev");
      // One input the shell parses before it runs anything: the command, then the completion.
      expect(typed.indexOf("npm run dev")).toBeGreaterThanOrEqual(0);
      expect(typed.indexOf("npm run dev")).toBeLessThan(typed.indexOf(`octant=${marker}`));
      expect(typed.split("\r").length).toBeLessThanOrEqual(2);
    },
  );

  it("groups a POSIX command in braces ahead of printf and reads its framed code", () => {
    const { wrap, pattern } = terminalCompletion("/bin/zsh", marker);
    const typed = wrap("npm test &");
    // A newline before the closing brace keeps a command ending in & valid.
    expect(typed.startsWith("{ npm test &\r}; printf")).toBe(true);
    const echoed = `% { npm test &\r\ncursh> ${typed.split("\r")[1]}\r\n`;
    expect(codes(echoed, pattern)).toEqual([]);
    expect(codes(`${echoed}\u001b]777;octant=${marker};exit=0\u0007`, pattern)).toEqual(["0"]);
  });

  it.each([powershell, pwsh])(
    "runs %s's command dot-sourced and reports a program's code over its error record, without assigning $LASTEXITCODE",
    (shell) => {
      const { wrap, pattern } = terminalCompletion(shell, marker);
      const typed = wrap("cmd /c exit 7");
      expect(typed).not.toContain("printf");
      expect(typed).toContain(". { cmd /c exit 7 }; $octantOk = $?;");
      // A later command still reads what the last program left.
      expect(typed).not.toMatch(/\$(global:)?LASTEXITCODE\s*=[^=]/);
      // A program that ran (even under $PSNativeCommandUseErrorActionPreference, which also
      // leaves an error record) reports its own code, checked before the error record.
      expect(typed.indexOf("ReferenceEquals($global:LASTEXITCODE")).toBeLessThan(
        typed.indexOf("$octantOk -and"),
      );
      // A failed cmdlet, or one under -ErrorAction Ignore that leaves no record, reports 1.
      expect(typed).toContain("} else { 1 }");
      // Plain text ending its line: a Windows 10 console host may drop an OSC sequence.
      expect(typed).toContain(`[Console]::WriteLine("octant=${marker};exit=$octantExit")`);
      const echoed = colouredEcho(typed);
      expect(codes(echoed, pattern)).toEqual([]);
      expect(codes(`${echoed}octant=${marker};exit=7\r\nPS C:\\work> `, pattern)).toEqual(["7"]);
      expect(codes(`${echoed}octant=${marker};exit=-1\r\n`, pattern)).toEqual(["-1"]);
    },
  );

  it("starts Command Prompt's line at ERRORLEVEL 0 and expands it after the command, with a signed code", () => {
    const { wrap, pattern } = terminalCompletion(cmd, marker);
    const typed = wrap("cd");
    // A successful built-in such as cd leaves ERRORLEVEL as it was, so it is set to 0 first.
    expect(typed).toBe(`(call ) & (cd) & call echo octant=${marker};exit=%^ERRORLEVEL%`);
    const echoed = `C:\\work>${typed}\r\n`;
    expect(codes(echoed, pattern)).toEqual([]);
    expect(codes(`${echoed}octant=${marker};exit=0\r\n\r\nC:\\work>`, pattern)).toEqual(["0"]);
    expect(codes(`${echoed}octant=${marker};exit=-1073741510\u001b[K\r\n`, pattern)).toEqual([
      "-1073741510",
    ]);
  });

  it.each([
    ["/bin/zsh", `\u001b]777;octant=${marker};exit=12`],
    [powershell, `octant=${marker};exit=12`],
    [cmd, `octant=${marker};exit=12`],
  ])("does not read %s's marker cut off mid-read as a finished command", (shell, partial) => {
    const { pattern } = terminalCompletion(shell, marker);
    expect(codes(partial, pattern)).toEqual([]);
  });
});
