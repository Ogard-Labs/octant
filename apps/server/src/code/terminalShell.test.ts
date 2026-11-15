import { describe, expect, it } from "vitest";
import { defaultTerminalShell, terminalShellFor, windowsShellArguments } from "./terminalShell";

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
