import { describe, expect, it } from "vitest";

import { ProcessConfinementError } from "./seatbeltProfile";
import {
  resolveWindowsProviderProgram,
  windowsUnconfinedLaunch,
  type WindowsProviderProgramFiles,
} from "./windowsProviderProgram";

const npm = "C:\\Users\\ada\\AppData\\Roaming\\npm";

/** npm's cmd-shim for a package whose bin is a Node script. */
const scriptShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

/** npm's cmd-shim for a package whose bin is a native program. */
const programShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*
`;

function files(entries: Readonly<Record<string, string>>): WindowsProviderProgramFiles {
  const lower = new Map(Object.entries(entries).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    exists: (path) => lower.has(path.toLowerCase()),
    read: (path) => {
      const text = lower.get(path.toLowerCase());
      if (text === undefined) throw new Error("missing");
      return text;
    },
  };
}

describe("a provider program on Windows", () => {
  it("starts a .exe as it is, with no shell", () => {
    expect(
      resolveWindowsProviderProgram({
        displayName: "Codex",
        executable: "C:\\Tools\\codex.exe",
        args: ["--version"],
        environment: {},
        files: files({}),
      }),
    ).toEqual({ status: "resolved", command: "C:\\Tools\\codex.exe", args: ["--version"] });
  });

  it("starts an npm shim's script with the node.exe on Path, never through the shim", () => {
    const shim = `${npm}\\claude.cmd`;
    const script = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(
      resolveWindowsProviderProgram({
        displayName: "Claude",
        executable: shim,
        args: ["--version"],
        environment: { Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs" },
        files: files({
          [shim]: scriptShim,
          [script]: "",
          "C:\\Program Files\\nodejs\\node.exe": "",
        }),
      }),
    ).toEqual({
      status: "resolved",
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [script, "--version"],
    });
  });

  it("prefers the node.exe beside the shim, as the shim does", () => {
    const shim = `${npm}\\claude.cmd`;
    const script = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const result = resolveWindowsProviderProgram({
      displayName: "Claude",
      executable: shim,
      args: [],
      environment: { PATH: "C:\\Program Files\\nodejs" },
      files: files({
        [shim]: scriptShim,
        [script]: "",
        [`${npm}\\node.exe`]: "",
        "C:\\Program Files\\nodejs\\node.exe": "",
      }),
    });
    expect(result).toMatchObject({ status: "resolved", command: `${npm}\\node.exe` });
  });

  it("starts the native program an npm shim names, and reads the shim when Settings names npm's extensionless script", () => {
    const program = `${npm}\\node_modules\\opencode-ai\\bin\\opencode.exe`;
    const known = files({ [`${npm}\\opencode.cmd`]: programShim, [program]: "" });
    for (const executable of [`${npm}\\opencode.cmd`, `${npm}\\opencode`, `${npm}\\opencode.ps1`]) {
      expect(
        resolveWindowsProviderProgram({
          displayName: "OpenCode",
          executable,
          args: ["serve"],
          environment: {},
          files: known,
        }),
      ).toEqual({ status: "resolved", command: program, args: ["serve"] });
    }
  });

  it("refuses a shim whose script needs Node when no node.exe can be found, naming the .exe to point Settings at", () => {
    const shim = `${npm}\\codex.cmd`;
    const result = resolveWindowsProviderProgram({
      displayName: "Codex",
      executable: shim,
      args: [],
      environment: { Path: "C:\\Windows\\System32" },
      programHint: "the codex.exe in the package's vendor folder",
      files: files({
        [shim]: scriptShim.replace(
          "@anthropic-ai\\claude-code\\cli.js",
          "@openai\\codex\\bin\\codex.js",
        ),
        [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: "",
      }),
    });
    expect(result).toEqual({
      status: "refused",
      message: expect.stringMatching(
        /codex\.cmd.*needs node\.exe.*point Settings at the codex\.exe in the package's vendor folder/,
      ),
    });
  });

  it("refuses a shim it cannot read a program from, naming the .exe and why a shell is not used", () => {
    const shim = `${npm}\\pi.cmd`;
    const result = resolveWindowsProviderProgram({
      displayName: "Pi",
      executable: shim,
      args: [],
      environment: {},
      files: files({ [shim]: "@ECHO off\r\ncall some-launcher %*\r\n" }),
    });
    expect(result).toEqual({
      status: "refused",
      message: expect.stringMatching(/pi\.cmd.*only through a shell.*the Pi \.exe instead/),
    });
  });

  it("refuses the launch through the unconfined port when the shim cannot be resolved", () => {
    const port = windowsUnconfinedLaunch({
      displayName: "Pi",
      environment: {},
      files: files({ [`${npm}\\pi.cmd`]: "@ECHO off\r\n" }),
    });
    expect(() =>
      port.prepare({
        executable: `${npm}\\pi.cmd`,
        args: [],
        boundRoot: "C:\\work",
        temporaryDirectory: "C:\\temp",
        networkEgress: "allow",
      }),
    ).toThrow(ProcessConfinementError);
  });
});
