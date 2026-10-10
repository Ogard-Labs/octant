import { describe, expect, it } from "vitest";
import { defaultTerminalShell } from "./terminalShell";

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
