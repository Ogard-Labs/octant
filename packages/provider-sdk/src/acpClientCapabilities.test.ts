import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AcpClientReadTextFileInput,
  AcpClientTerminalCreateInput,
  AcpClientTerminalOutputResult,
  ACP_CLIENT_TOOL_NAMES,
} from "./acpClientCapabilities";

describe("ACP client capability schemas", () => {
  it("decodes ACP filesystem and terminal shapes", () => {
    expect(
      Schema.decodeUnknownSync(AcpClientReadTextFileInput)({
        path: "/checkout/README.md",
        line: 1,
        limit: 20,
      }),
    ).toEqual({ path: "/checkout/README.md", line: 1, limit: 20 });
    expect(
      Schema.decodeUnknownSync(AcpClientTerminalCreateInput)({
        command: "git",
        args: ["status"],
        env: [{ name: "LANG", value: "C" }],
        cwd: "/checkout",
        outputByteLimit: 1024,
      }),
    ).toMatchObject({ command: "git", cwd: "/checkout" });
    expect(
      Schema.decodeUnknownSync(AcpClientTerminalOutputResult)({
        output: "done",
        truncated: false,
        exitStatus: { exitCode: 0 },
      }),
    ).toEqual({ output: "done", truncated: false, exitStatus: { exitCode: 0 } });
  });

  it("rejects extra fields and wrong types", () => {
    expect(() =>
      Schema.decodeUnknownSync(AcpClientReadTextFileInput)({
        path: "/checkout/README.md",
        sessionId: "not-in-backing-schema",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AcpClientTerminalCreateInput)({
        command: 7,
      }),
    ).toThrow();
  });

  it("publishes stable Octant tool names", () => {
    expect(ACP_CLIENT_TOOL_NAMES.readTextFile).toBe("octant_acp_fs_read_text_file");
    expect(ACP_CLIENT_TOOL_NAMES.terminalRelease).toBe("octant_acp_terminal_release");
  });
});
