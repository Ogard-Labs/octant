import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MCP_COMMAND_HELP, NO_BROWSER_GRANT_MESSAGE } from "./mcpCommand";
import { runTerminalLauncher, TERMINAL_LAUNCHER_USAGE } from "./terminalLauncher";

async function run(argv: ReadonlyArray<string>, lines: ReadonlyArray<string> = []) {
  const input = new PassThrough();
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  let stdout = "";
  let stderr = "";
  const code = await runTerminalLauncher(argv, {
    environment: {},
    input,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
  });
  return { code, stdout, stderr };
}

describe("the octant the desktop app puts on a granted terminal's PATH", () => {
  it("runs octant mcp, which without a grant lists no tools", async () => {
    const result = await run(["mcp"], ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(result.stderr).toBe(`${NO_BROWSER_GRANT_MESSAGE}\n`);
  });

  it("answers octant mcp's help and refuses its stray arguments as the full command does", async () => {
    expect(await run(["mcp", "--help"])).toEqual({ code: 0, stdout: MCP_COMMAND_HELP, stderr: "" });
    expect(await run(["mcp", "--port", "1"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "octant mcp takes no arguments. Run `octant mcp --help`.\n",
    });
  });

  it("runs no other command, and says what it is instead", async () => {
    expect(await run(["--help"])).toEqual({ code: 0, stdout: TERMINAL_LAUNCHER_USAGE, stderr: "" });
    for (const argv of [[], ["web"], ["server", "start"], ["agent"]]) {
      expect(await run(argv)).toEqual({ code: 1, stdout: "", stderr: TERMINAL_LAUNCHER_USAGE });
    }
  });
});
